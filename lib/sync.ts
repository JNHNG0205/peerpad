// Browser sync for one workspace.
//  - Documents: "root" (page list, titles, icons) is always loaded; each page's content is its own
//    document, loaded when the page is opened and released a little after it is closed.
//  - PeerPad server = encrypted relay and always-on copy (everything is encrypted before it leaves the browser)
//  - BroadcastChannel = instant sync between tabs of the same browser
//  - IndexedDB = offline copy of every document this browser has opened
//  - Awareness = who is online, which page they are on, and live cursors (sent at most ~8 times a second)
import * as Y from 'yjs'
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { serverConnection, type Signer, type TransportState, type DocChannel } from './remote.ts'

export { generateWriteKeys, loadSigner } from './remote.ts'

/* ---------- IndexedDB ---------- */
function openDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('peerpad', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('docs')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
async function idbGet(key: string): Promise<Uint8Array | null> {
  try {
    const db = await openDB()
    return await new Promise((res) => {
      const q = db.transaction('docs').objectStore('docs').get(key)
      q.onsuccess = () => res(q.result ?? null)
      q.onerror = () => res(null)
    })
  } catch { return null }
}
const idbPut = (key: string, value: Uint8Array) => openDB().then((db) => db.transaction('docs', 'readwrite').objectStore('docs').put(value, key)).catch(() => {})
const idbDelete = (key: string) => openDB().then((db) => db.transaction('docs', 'readwrite').objectStore('docs').delete(key)).catch(() => {})
// the root document keeps the key earlier versions used for the whole workspace
const idbKey = (ws: string, d: string) => (d === 'root' ? ws : `${ws}:p:${d}`)

/** Load this browser's offline copy of the workspace's root document. */
export async function loadLocal(doc: Y.Doc, ws: string): Promise<boolean> {
  const data = await idbGet(idbKey(ws, 'root'))
  if (data) Y.applyUpdate(doc, data, 'idb')
  return !!data
}

export type Peer = { clientId: number; name: string; color: string; page: string | null; role: 'edit' | 'view' }
export type NetStatus = { server: TransportState['status'] | null; serverError: string | null; readOnly: boolean }
export type Net = ReturnType<typeof connect>

export function connect(root: Y.Doc, ws: string, key: string, serverUrl: string | null = null, signerIn: Signer | null = null) {
  let signer = signerIn
  const awareness = new Awareness(root)
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((f) => f())
  const readOnly = () => !!signer && !signer.canWrite

  const conn = serverUrl
    ? serverConnection(ws, key, serverUrl, String(root.clientID), {
        emit,
        onSigner: (s) => { signer = s; emit() },
        onConnect: () => conn?.sendAwareness(encodeAwarenessUpdate(awareness, [root.clientID])),
        onAwareness: (_tab, u) => { try { applyAwarenessUpdate(awareness, u, 'srv') } catch {} },
        onLeave: (t) => { const id = Number(t); if (id && id !== root.clientID) removeAwarenessStates(awareness, [id], 'srv') },
        onDropped: (d) => { idbDelete(idbKey(ws, d)) },
      }, signer)
    : null
  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('peerpad2:' + ws) : null

  /* ---------- attaching a document to every transport ---------- */
  type Attached = { d: string; doc: Y.Doc; channel: DocChannel | null; detach: () => void }
  const attached = new Map<string, Attached>()
  function attach(d: string, doc: Y.Doc): Attached {
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    const save = () => idbPut(idbKey(ws, d), Y.encodeStateAsUpdate(doc))
    const channel = conn ? conn.addDoc(d, doc) : null
    // edits to the server are bundled over 40 ms (one message per burst of typing, not per keystroke)
    let pending: Uint8Array[] = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      flushTimer = null
      if (!pending.length) return
      const u = pending.length === 1 ? pending[0] : Y.mergeUpdates(pending)
      pending = []
      if (channel?.ready && !readOnly()) channel.sendUpdate(u).catch(() => {}) // if not connected, the next connect uploads what is missing
    }
    const onUpdate = (u: Uint8Array, origin: unknown) => {
      if (origin !== 'bc') bc?.postMessage({ t: 'up', d, u })
      if (origin !== 'srv' && channel) { pending.push(u); if (!flushTimer) flushTimer = setTimeout(flush, 40) }
      clearTimeout(saveTimer)
      saveTimer = setTimeout(save, 400)
    }
    doc.on('update', onUpdate)
    bc?.postMessage({ t: 'sv', d, sv: Y.encodeStateVector(doc) })
    const a: Attached = {
      d, doc, channel,
      detach() {
        if (flushTimer) { clearTimeout(flushTimer); flush() }
        doc.off('update', onUpdate)
        clearTimeout(saveTimer)
        save()
        channel?.close()
        attached.delete(d)
      },
    }
    attached.set(d, a)
    return a
  }
  if (bc) {
    bc.onmessage = ({ data: m }) => {
      if (m.t === 'aw') { try { applyAwarenessUpdate(awareness, m.u, 'bc') } catch {} ; return }
      const a = attached.get(m.d)
      if (!a) return
      if (m.t === 'up') Y.applyUpdate(a.doc, m.u, 'bc')
      else if (m.t === 'sv') {
        bc.postMessage({ t: 'up', d: m.d, u: Y.encodeStateAsUpdate(a.doc, m.sv) })
        if (!m.reply) bc.postMessage({ t: 'sv', d: m.d, sv: Y.encodeStateVector(a.doc), reply: true })
      }
    }
  }
  const rootAttached = attach('root', root)

  /* ---------- pages, loaded on demand ---------- */
  type PageEntry = { doc: Y.Doc; refs: number; loaded: Promise<void>; a: Attached | null; releaseTimer: ReturnType<typeof setTimeout> | null }
  const pages = new Map<string, PageEntry>()
  function acquire(id: string): PageEntry {
    let p = pages.get(id)
    if (!p) {
      const doc = new Y.Doc()
      doc.clientID = root.clientID // one identity per browser tab, so live cursors match presence
      const entry: PageEntry = { doc, refs: 0, a: null, releaseTimer: null, loaded: Promise.resolve() }
      entry.loaded = (async () => {
        const local = await idbGet(idbKey(ws, id))
        if (local) Y.applyUpdate(doc, local, 'idb')
        entry.a = attach(id, doc)
        // wait for the server's copy, but don't block on a slow network: local content shows first
        if (entry.a.channel) await Promise.race([entry.a.channel.whenReady(20000).catch(() => {}), new Promise((r) => setTimeout(r, local ? 300 : 4000))])
      })()
      p = entry
      pages.set(id, p)
    }
    if (p.releaseTimer) { clearTimeout(p.releaseTimer); p.releaseTimer = null }
    p.refs++
    return p
  }
  function release(id: string) {
    const p = pages.get(id)
    if (!p) return
    p.refs = Math.max(0, p.refs - 1)
    if (p.refs === 0 && !p.releaseTimer) {
      // keep recently viewed pages warm for a minute
      p.releaseTimer = setTimeout(() => { p.a?.detach(); p.doc.destroy(); pages.delete(id) }, 60_000)
    }
  }

  /* ---------- presence: sent at most ~8 times a second ---------- */
  let awTimer: ReturnType<typeof setTimeout> | null = null
  const flushAwareness = () => {
    awTimer = null
    const u = encodeAwarenessUpdate(awareness, [root.clientID])
    bc?.postMessage({ t: 'aw', u })
    conn?.sendAwareness(u)
  }
  awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const mine = [...added, ...updated, ...removed].includes(root.clientID)
    if (mine && origin !== 'srv' && origin !== 'bc' && !awTimer) awTimer = setTimeout(flushAwareness, 125)
    emit()
  })
  addEventListener('pagehide', () => {
    for (const a of attached.values()) idbPut(idbKey(ws, a.d), Y.encodeStateAsUpdate(a.doc))
    removeAwarenessStates(awareness, [root.clientID], 'local')
    flushAwareness()
  })

  return {
    awareness,
    onChange(f: () => void) { listeners.add(f); return () => listeners.delete(f) },
    /** Open a page's document (load from this browser, then the server). Call releasePage when done. */
    async openPage(id: string): Promise<Y.Doc> {
      const p = acquire(id)
      await p.loaded
      return p.doc
    },
    releasePage: release,
    /** Run fn with a page's document, then release it. */
    async withPage<T>(id: string, fn: (doc: Y.Doc) => T | Promise<T>): Promise<T> {
      const p = acquire(id)
      try { await p.loaded; return await fn(p.doc) } finally { release(id) }
    },
    /** Content of a page from this browser only (for search), without connecting. */
    async peekPage(id: string): Promise<Y.Doc | null> {
      const open = pages.get(id)
      if (open) return open.doc
      const data = await idbGet(idbKey(ws, id))
      if (!data) return null
      const doc = new Y.Doc()
      Y.applyUpdate(doc, data)
      return doc
    },
    /** Delete pages' content on the server and in this browser (after removing them from the page list). */
    dropPages(ids: string[]) {
      for (const id of ids) { conn?.dropDoc(id); idbDelete(idbKey(ws, id)) }
    },
    rootReady: () => rootAttached.channel?.whenReady() ?? Promise.resolve(),
    /** Fields shown to others: name, color, current page, role. Cursor data is added by the editor. */
    setPresence(p: { name: string; color: string; page: string | null }) {
      awareness.setLocalStateField('user', { name: p.name, color: p.color })
      awareness.setLocalStateField('page', p.page)
      awareness.setLocalStateField('role', readOnly() ? 'view' : 'edit')
    },
    peers(): Peer[] {
      const out: Peer[] = []
      awareness.getStates().forEach((s: any, id: number) => {
        if (id === root.clientID || !s?.user) return
        out.push({ clientId: id, name: s.user.name || 'Anonymous', color: s.user.color || '#888', page: s.page ?? null, role: s.role === 'view' ? 'view' : 'edit' })
      })
      return out
    },
    status(): NetStatus {
      return { server: conn ? conn.state.status : null, serverError: conn?.state.error ?? null, readOnly: readOnly() }
    },
    get signer() { return signer },
    /** Encrypted file storage on the server; null without a server. */
    assets: conn ? { upload: (bytes: Uint8Array) => conn.uploadAsset(bytes), fetch: (id: string) => conn.fetchAsset(id) } : null,
    close: () => { conn?.close(); bc?.close() },
  }
}
