// Browser sync for one workspace.
//  - Yjs doc = source of truth (merges concurrent edits without conflicts)
//  - PeerPad server = encrypted relay and always-on copy (everything is encrypted before it leaves the browser)
//  - BroadcastChannel = instant sync between tabs of the same browser
//  - IndexedDB = offline copy
//  - Awareness = who is online, which page they are on, and live cursors
import * as Y from 'yjs'
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { serverTransport, type Signer, type Transport } from './remote.ts'

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
export async function loadLocal(doc: Y.Doc, ws: string): Promise<boolean> {
  try {
    const db = await openDB()
    const data = await new Promise<Uint8Array | null>((res) => {
      const q = db.transaction('docs').objectStore('docs').get(ws)
      q.onsuccess = () => res(q.result ?? null)
      q.onerror = () => res(null)
    })
    if (data) Y.applyUpdate(doc, data, 'idb')
    return !!data
  } catch {
    return false
  }
}
function saveLocal(doc: Y.Doc, ws: string) {
  openDB().then((db) => db.transaction('docs', 'readwrite').objectStore('docs').put(Y.encodeStateAsUpdate(doc), ws)).catch(() => {})
}

export type Peer = { clientId: number; name: string; color: string; page: string | null; role: 'edit' | 'view'; via?: string }
export type NetStatus = { server: Transport['state']['status'] | null; serverError: string | null; readOnly: boolean }
export type Net = ReturnType<typeof connect>

export function connect(doc: Y.Doc, ws: string, key: string, serverUrl: string | null = null, signerIn: Signer | null = null) {
  let signer = signerIn
  const awareness = new Awareness(doc)
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((f) => f())
  const tab = String(doc.clientID)
  const readOnly = () => !!signer && !signer.canWrite

  // ---- persistence
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveLocal(doc, ws), 400) }

  // ---- same-browser tabs
  const bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('peerpad:' + ws) : null
  if (bc) {
    bc.onmessage = ({ data: m }) => {
      if (m.t === 'up') Y.applyUpdate(doc, m.u, 'bc')
      else if (m.t === 'sv') {
        bc.postMessage({ t: 'up', u: Y.encodeStateAsUpdate(doc, m.sv) })
        if (!m.reply) bc.postMessage({ t: 'sv', sv: Y.encodeStateVector(doc), reply: true })
        bc.postMessage({ t: 'aw', u: encodeAwarenessUpdate(awareness, [doc.clientID]) })
      } else if (m.t === 'aw') applyAwarenessUpdate(awareness, m.u, 'bc')
    }
    bc.postMessage({ t: 'sv', sv: Y.encodeStateVector(doc) })
  }

  // ---- sync server
  const srv = serverUrl
    ? serverTransport(doc, ws, key, serverUrl, tab, {
        emit,
        onSigner: (s) => { signer = s; emit() },
        onReady: () => srv?.sendAwareness(encodeAwarenessUpdate(awareness, [doc.clientID])),
        onAwareness: (_tab, u) => { try { applyAwarenessUpdate(awareness, u, 'srv') } catch {} },
        onLeave: (t) => { const id = Number(t); if (id && id !== doc.clientID) removeAwarenessStates(awareness, [id], 'srv') },
      }, signer)
    : null

  // Relay every change to the transports it did not come from. Yjs ignores updates it already has.
  doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'bc' && bc) bc.postMessage({ t: 'up', u })
    if (origin !== 'srv' && srv && srv.state.status === 'connected' && !readOnly()) srv.sendUpdate(u).catch(() => {})
    scheduleSave()
  })
  // Our own presence changes (and the periodic renewal) go out on every transport.
  awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const mine = [...added, ...updated, ...removed].filter((id) => id === doc.clientID)
    if (mine.length && origin !== 'srv' && origin !== 'bc') {
      const u = encodeAwarenessUpdate(awareness, mine)
      bc?.postMessage({ t: 'aw', u })
      srv?.sendAwareness(u)
    }
    emit()
  })
  addEventListener('pagehide', () => {
    saveLocal(doc, ws)
    removeAwarenessStates(awareness, [doc.clientID], 'local')
  })

  return {
    awareness,
    onChange(f: () => void) { listeners.add(f); return () => listeners.delete(f) },
    /** Fields shown to others: name, color, current page, role. Cursor data is added by the editor. */
    setPresence(p: { name: string; color: string; page: string | null }) {
      awareness.setLocalStateField('user', { name: p.name, color: p.color })
      awareness.setLocalStateField('page', p.page)
      awareness.setLocalStateField('role', readOnly() ? 'view' : 'edit')
    },
    peers(): Peer[] {
      const out: Peer[] = []
      awareness.getStates().forEach((s: any, id: number) => {
        if (id === doc.clientID || !s?.user) return
        out.push({ clientId: id, name: s.user.name || 'Anonymous', color: s.user.color || '#888', page: s.page ?? null, role: s.role === 'view' ? 'view' : 'edit' })
      })
      return out
    },
    status(): NetStatus {
      return { server: srv ? srv.state.status : null, serverError: srv?.state.error ?? null, readOnly: readOnly() }
    },
    get signer() { return signer },
    /** Encrypted file storage on the sync server; null without a server. */
    assets: srv ? { upload: (bytes: Uint8Array) => srv.uploadAsset(bytes), fetch: (id: string) => srv.fetchAsset(id) } : null,
    close: () => { srv?.close(); bc?.close() },
  }
}
