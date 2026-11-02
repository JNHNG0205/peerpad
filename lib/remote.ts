// Encrypted connection to a PeerPad sync server.
// Shared by the web app and the MCP server: uses only Web APIs that Node 22+ also has.
import * as Y from 'yjs'

export const newTabId = (): string => Math.random().toString(36).slice(2, 12)

/* ---------- encoding ---------- */
const te = new TextEncoder()
function b64(u8: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)))
  return btoa(s)
}
function unb64(s: string): Uint8Array {
  const bin = atob(s)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}
export const b64u = (u8: Uint8Array): string => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const unb64u = (s: string): Uint8Array => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
const buf = (u: Uint8Array): ArrayBuffer => u.slice().buffer as ArrayBuffer

/* ---------- end-to-end encryption (AES-GCM, key derived from the invite key) ---------- */
async function deriveKey(key: string, ws: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', te.encode(key), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: te.encode('peerpad:' + ws), iterations: 150000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
async function sealBytes(k: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, buf(bytes)))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  return out
}
async function unsealBytes(k: CryptoKey, u: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(u.subarray(0, 12)) }, k, buf(u.subarray(12))))
}
const seal = async (k: CryptoKey, bytes: Uint8Array) => b64(await sealBytes(k, bytes))
const unseal = async (k: CryptoKey, s: string) => unsealBytes(k, unb64(s))

async function roomHash(ws: string, key: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(`peerpad-room:${ws}:${key}`)))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/* ---------- write permission (ECDSA P-256) ----------
 * Edit links carry the private key (sk), view links only the public key (pk).
 * Every change is signed; the server drops changes without a valid signature. */
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }
const SIG = { name: 'ECDSA', hash: 'SHA-256' }
export type Signer = {
  pk: string
  canWrite: boolean
  sign: (bytes: Uint8Array) => Promise<Uint8Array>
  verify: (sig: Uint8Array, bytes: Uint8Array) => Promise<boolean>
}
export async function generateWriteKeys(): Promise<{ pk: string; sk: string }> {
  const kp = (await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify'])) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey)
  return { pk: b64u(raw), sk: jwk.d as string }
}
/** null = workspace without view-only links. */
export async function loadSigner(pk?: string | null, sk?: string | null): Promise<Signer | null> {
  if (!pk) return null
  const raw = unb64u(pk)
  const verifyKey = await crypto.subtle.importKey('raw', buf(raw), ECDSA, false, ['verify'])
  const verify = async (sig: Uint8Array, bytes: Uint8Array) => {
    try { return await crypto.subtle.verify(SIG, verifyKey, buf(sig), buf(bytes)) } catch { return false }
  }
  let signKey: CryptoKey | null = null
  if (sk) {
    try {
      signKey = await crypto.subtle.importKey('jwk',
        { kty: 'EC', crv: 'P-256', d: sk, x: b64u(raw.slice(1, 33)), y: b64u(raw.slice(33, 65)), ext: true }, ECDSA, false, ['sign'])
      const probe = te.encode('peerpad-probe')
      if (!(await verify(new Uint8Array(await crypto.subtle.sign(SIG, signKey, buf(probe))), probe))) signKey = null
    } catch { signKey = null }
  }
  return {
    pk,
    canWrite: !!signKey,
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign(SIG, signKey as CryptoKey, buf(bytes))),
    verify,
  }
}

/* ---------- transport ---------- */
// One encrypted WebSocket per workspace, carrying several documents: "root" (page list) and one per
// open page. Each document is subscribed separately, so a browser only downloads and receives the pages
// it has open.
export type TransportHooks = {
  emit?: () => void
  /** awareness update (presence + cursors) from another client */
  onAwareness?: (tab: string, update: Uint8Array) => void
  onLeave?: (tab: string) => void
  onConnect?: () => void
  onDisconnect?: () => void
  onSigner?: (signer: Signer) => void
  /** a page's history was deleted (the page was deleted) */
  onDropped?: (d: string) => void
}
export type TransportState = { status: 'connecting' | 'connected' | 'offline' | 'error' | 'closed'; error: string | null; everReady: boolean; readOnly: boolean }
export type Connection = ReturnType<typeof serverConnection>
export type DocChannel = {
  /** resolves once the server's copy has been merged in */
  whenReady(timeoutMs?: number): Promise<void>
  /** resolves when the server has stored the update */
  sendUpdate(u: Uint8Array): Promise<void>
  readonly ready: boolean
  close(): void
}
/** A document's history is compacted once it has this many rows on the server. */
export const COMPACT_AT = 150

export function serverConnection(ws: string, key: string, url: string, tabId: string, hooks: TransportHooks = {}, signerIn: Signer | null = null) {
  const h = { emit() {}, onAwareness() {}, onLeave() {}, onConnect() {}, onDisconnect() {}, onSigner() {}, onDropped() {}, ...hooks } as Required<TransportHooks>
  let signer = signerIn
  const st: TransportState = { status: 'connecting', error: null, everReady: false, readOnly: !!signer && !signer.canWrite }
  const signData = async (data: string) => (signer?.canWrite ? b64u(await signer.sign(te.encode(data))) : undefined)
  let sock: WebSocket | null = null
  let k: CryptoKey | null = null
  let room: string | null = null
  let open_ = false, retry = 1000, closed = false, pubKnown = false
  // Encryption is async; this chain keeps sends in the same order as the edits.
  let chain: Promise<unknown> = Promise.resolve()
  const enqueue = (fn: () => Promise<unknown> | unknown) => (chain = chain.then(fn, fn))
  const sendJSON = (o: unknown) => { if (sock?.readyState === 1) sock.send(JSON.stringify(o)) }

  type Ch = {
    d: string; doc: Y.Doc; ready: boolean; lastSeq: number; n: number
    acks: { resolve: () => void; reject: (e: Error) => void }[]
    waiters: (() => void)[]; compactTimer: ReturnType<typeof setTimeout> | null
  }
  const channels = new Map<string, Ch>()

  async function start() {
    try {
      if (!globalThis.crypto?.subtle) throw new Error('Encryption needs HTTPS (or localhost).')
      k = await deriveKey(key, ws)
      room = await roomHash(ws, key)
      connect()
    } catch (e) {
      st.status = 'error'; st.error = (e as Error).message; h.emit()
    }
  }
  function connect() {
    if (closed) return
    try {
      const u = new URL(url)
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
      u.pathname = u.pathname.replace(/\/+$/, '') + '/sync'
      u.search = `?room=${room}&v=2`
      sock = new WebSocket(u)
    } catch {
      st.status = 'error'; st.error = 'Invalid server address.'; h.emit(); return
    }
    st.status = 'connecting'; h.emit()
    sock.onopen = () => {
      retry = 1000
      open_ = true
      st.status = 'connected'; st.error = null; st.everReady = true
      for (const c of channels.values()) sendJSON({ t: 'sub', d: c.d })
      h.onConnect()
      h.emit()
    }
    sock.onmessage = async (ev) => {
      let m: any
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)) } catch { return }
      const kk = k as CryptoKey
      const c = m.d !== undefined ? channels.get(m.d) : undefined
      if (m.t === 'init' && c) {
        if (!(await checkPub(m.pub))) return
        const shadow = new Y.Doc() // what the server already has
        const updates: Uint8Array[] = []
        for (const e of m.entries) {
          try { updates.push(await unseal(kk, e.data)) } catch { /* wrong key or corrupt entry */ }
        }
        if (m.entries.length && !updates.length) {
          st.status = 'error'; st.error = 'Could not decrypt this workspace. Check the invite link.'; h.emit(); return
        }
        c.lastSeq = m.seq
        c.n = m.n ?? m.entries.length
        c.doc.transact(() => {
          for (const u of updates) { Y.applyUpdate(shadow, u); Y.applyUpdate(c.doc, u, 'srv') }
        }, 'srv')
        // upload whatever the server is missing (offline edits, or a new document)
        const missing = Y.encodeStateAsUpdate(c.doc, Y.encodeStateVector(shadow))
        c.ready = true
        if (missing.length > 2 && !st.readOnly) sendUpdate(c, missing).catch(() => {})
        maybeCompact(c)
        c.waiters.forEach((f) => f()); c.waiters = []
        h.emit()
      } else if (m.t === 'up' && c) {
        c.lastSeq = Math.max(c.lastSeq, m.seq)
        c.n++
        try { Y.applyUpdate(c.doc, await unseal(kk, m.data), 'srv') } catch {}
        maybeCompact(c)
      } else if (m.t === 'ack' && c) {
        c.lastSeq = Math.max(c.lastSeq, m.seq)
        if (typeof m.n === 'number') c.n = m.n
        c.acks.shift()?.resolve()
        maybeCompact(c)
      } else if (m.t === 'compacted' && c) {
        c.n = typeof m.n === 'number' ? m.n : 0 // skipped: someone else just compacted
      } else if (m.t === 'dropped') {
        h.onDropped(m.d)
      } else if (m.t === 'pres') {
        try { h.onAwareness(m.tab, await unseal(kk, m.data)) } catch {}
      } else if (m.t === 'leave') {
        h.onLeave(m.tab)
      } else if (m.t === 'pub') {
        await checkPub(m.pub)
        h.emit()
      } else if (m.t === 'error') {
        if (m.for === 'up' && c) c.acks.shift()?.reject(new Error(m.error))
        else st.error = m.error
        h.emit()
      }
    }
    sock.onclose = () => {
      open_ = false
      st.status = closed ? 'closed' : 'offline'
      // unacked updates are re-sent by the init diff after reconnecting
      for (const c of channels.values()) {
        c.ready = false
        c.acks.forEach((a) => a.reject(new Error('Connection to the server dropped.')))
        c.acks = []
      }
      h.onDisconnect()
      h.emit()
      if (closed) return
      setTimeout(connect, retry)
      retry = Math.min(retry * 2, 30000)
    }
  }
  /** Permissions: the server remembers the workspace's public key. */
  async function checkPub(pub: string | null | undefined): Promise<boolean> {
    if (pub && signer && pub !== signer.pk) {
      st.status = 'error'; st.error = 'This link does not match the workspace. Ask for a new invite link.'; h.emit(); return false
    }
    if (pub && !signer) {
      // an old link opening an upgraded workspace: it can still read, but no longer edit
      signer = await loadSigner(pub)
      if (signer) h.onSigner(signer)
    }
    if (signer && !pub && signer.canWrite && !pubKnown) sendJSON({ t: 'claim', pub: signer.pk })
    pubKnown = true
    st.readOnly = !!signer && !signer.canWrite
    return true
  }
  function sendUpdate(c: Ch, u: Uint8Array): Promise<void> {
    if (st.readOnly) return Promise.reject(new Error('This link is view-only.'))
    if (!c.ready || !open_) return Promise.reject(new Error('Not connected to the server.'))
    return new Promise((resolve, reject) => {
      enqueue(async () => {
        const data = await seal(k as CryptoKey, u)
        const sig = await signData(data)
        if (!c.ready || sock?.readyState !== 1) return reject(new Error('Not connected to the server.'))
        c.acks.push({ resolve, reject })
        sock.send(JSON.stringify({ t: 'up', d: c.d, data, sig }))
      })
    })
  }
  /** Long histories are replaced by one encrypted snapshot. Only editors can do this (the server can't read it). */
  function maybeCompact(c: Ch) {
    if (c.n < COMPACT_AT || c.compactTimer || st.readOnly || !c.ready) return
    // a random delay, so several editors don't all compact at once (the server also ignores repeats)
    c.compactTimer = setTimeout(() => {
      c.compactTimer = null
      if (c.n < COMPACT_AT || !c.ready || st.readOnly) return
      const upTo = c.lastSeq
      enqueue(async () => {
        const data = await seal(k as CryptoKey, Y.encodeStateAsUpdate(c.doc))
        sendJSON({ t: 'compact', d: c.d, upTo, data, sig: await signData(data) })
      })
    }, 1500 + Math.random() * 8000)
  }
  const assetUrl = (id: string) => {
    const u = new URL(url)
    u.pathname = u.pathname.replace(/\/+$/, '') + `/assets/${room}/${id}`
    u.search = ''
    return u.href
  }
  const whenKeys = () => new Promise<void>((res, rej) => {
    const t0 = Date.now()
    const tick = () => (k && room ? res() : Date.now() - t0 > 10000 ? rej(new Error(st.error || 'Encryption keys not ready.')) : setTimeout(tick, 50))
    tick()
  })
  start()
  return {
    state: st,
    get signer() { return signer },
    /** Subscribe a Y.Doc to a server document ("root" or a page id). */
    addDoc(d: string, doc: Y.Doc): DocChannel {
      const c: Ch = { d, doc, ready: false, lastSeq: 0, n: 0, acks: [], waiters: [], compactTimer: null }
      channels.set(d, c)
      if (open_) sendJSON({ t: 'sub', d })
      return {
        get ready() { return c.ready },
        whenReady(timeoutMs = 15000) {
          if (c.ready) return Promise.resolve()
          return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error(st.error || `Could not reach the server at ${url}.`)), timeoutMs)
            c.waiters.push(() => { clearTimeout(t); resolve() })
          })
        },
        sendUpdate: (u) => sendUpdate(c, u),
        close() {
          if (c.compactTimer) clearTimeout(c.compactTimer)
          channels.delete(d)
          sendJSON({ t: 'unsub', d })
        },
      }
    },
    /** Delete a page's history on the server (after the page itself was deleted). */
    async dropDoc(d: string) {
      if (st.readOnly || d === 'root') return
      enqueue(async () => sendJSON({ t: 'drop', d, sig: await signData('drop:' + d) }))
    },
    /** awareness update (presence + cursors), encrypted */
    sendAwareness(update: Uint8Array) {
      if (open_) enqueue(async () => sendJSON({ t: 'pres', tab: tabId, data: await seal(k as CryptoKey, update) }))
    },
    close() { closed = true; sock?.close() },
    /** Encrypt and store a file (image) on the server. Returns its id. */
    async uploadAsset(bytes: Uint8Array): Promise<string> {
      if (st.readOnly) throw new Error('This link is view-only.')
      if (!k) await whenKeys()
      const id = b64u(crypto.getRandomValues(new Uint8Array(16)))
      const body = await sealBytes(k as CryptoKey, bytes)
      const headers: Record<string, string> = { 'content-type': 'application/octet-stream' }
      if (signer?.canWrite) headers['x-peerpad-sig'] = b64u(await signer.sign(body))
      const r = await fetch(assetUrl(id), { method: 'PUT', body: buf(body), headers })
      if (!r.ok) throw new Error((await r.text().catch(() => '')) || `Upload failed (${r.status}).`)
      return id
    },
    /** Download and decrypt a stored file. */
    async fetchAsset(id: string): Promise<Uint8Array> {
      if (!k) await whenKeys()
      const r = await fetch(assetUrl(id))
      if (!r.ok) throw new Error(r.status === 404 ? 'Image not found on the server.' : `Download failed (${r.status}).`)
      return unsealBytes(k as CryptoKey, new Uint8Array(await r.arrayBuffer()))
    },
  }
}
