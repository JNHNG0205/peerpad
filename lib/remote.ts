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
export type TransportHooks = {
  emit?: () => void
  onReady?: () => void
  /** awareness update (presence + cursors) from another client */
  onAwareness?: (tab: string, update: Uint8Array) => void
  onLeave?: (tab: string) => void
  onDisconnect?: () => void
  onSigner?: (signer: Signer) => void
}
export type TransportState = { status: 'connecting' | 'connected' | 'offline' | 'error' | 'closed'; error: string | null; everReady: boolean; readOnly: boolean }
export type Transport = ReturnType<typeof serverTransport>

/**
 * Connects a Y.Doc to a sync server. The server stores and relays encrypted updates only.
 * tabId identifies this client for presence; use String(doc.clientID) to match awareness.
 */
export function serverTransport(doc: Y.Doc, ws: string, key: string, url: string, tabId: string, hooks: TransportHooks = {}, signerIn: Signer | null = null) {
  const h = { emit() {}, onReady() {}, onAwareness() {}, onLeave() {}, onDisconnect() {}, onSigner() {}, ...hooks } as Required<TransportHooks>
  let signer = signerIn
  const st: TransportState = { status: 'connecting', error: null, everReady: false, readOnly: !!signer && !signer.canWrite }
  const signData = async (data: string) => (signer?.canWrite ? b64u(await signer.sign(te.encode(data))) : undefined)
  let sock: WebSocket | null = null
  let k: CryptoKey | null = null
  let room: string | null = null
  let ready = false, retry = 1000, lastSeq = 0, closed = false
  let acks: { resolve: () => void; reject: (e: Error) => void }[] = [] // acks arrive in send order
  let readyWaiters: (() => void)[] = []
  const sendJSON = (o: unknown) => { if (sock?.readyState === 1) sock.send(JSON.stringify(o)) }
  // Encryption is async; this chain keeps sends in the same order as the edits.
  let chain: Promise<unknown> = Promise.resolve()
  const enqueue = (fn: () => Promise<unknown> | unknown) => (chain = chain.then(fn, fn))

  async function start() {
    try {
      if (!globalThis.crypto?.subtle) throw new Error('Encryption needs HTTPS (or localhost).')
      k = await deriveKey(key, ws)
      room = await roomHash(ws, key)
      open()
    } catch (e) {
      st.status = 'error'; st.error = (e as Error).message; h.emit()
    }
  }
  function open() {
    if (closed) return
    try {
      const u = new URL(url)
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
      u.pathname = u.pathname.replace(/\/+$/, '') + '/sync'
      u.search = '?room=' + room
      sock = new WebSocket(u)
    } catch {
      st.status = 'error'; st.error = 'Invalid sync server address.'; h.emit(); return
    }
    st.status = 'connecting'; h.emit()
    sock.onopen = () => { retry = 1000 }
    sock.onmessage = async (ev) => {
      let m: any
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)) } catch { return }
      const kk = k as CryptoKey
      if (m.t === 'init') {
        const shadow = new Y.Doc() // what the server already has
        const updates: Uint8Array[] = []
        for (const e of m.entries) {
          try { updates.push(await unseal(kk, e.data)) } catch { /* wrong key or corrupt entry */ }
        }
        if (m.entries.length && !updates.length) {
          st.status = 'error'; st.error = 'Could not decrypt this workspace. Check the invite link.'; h.emit(); return
        }
        lastSeq = m.seq
        if (m.pub && signer && m.pub !== signer.pk) {
          st.status = 'error'; st.error = 'This link does not match the workspace. Ask for a new invite link.'; h.emit(); return
        }
        if (m.pub && !signer) {
          // an old link opening an upgraded workspace: it can still read, but no longer edit
          signer = await loadSigner(m.pub)
          if (signer) h.onSigner(signer)
        }
        if (signer && !m.pub && signer.canWrite) sendJSON({ t: 'claim', pub: signer.pk })
        st.readOnly = !!signer && !signer.canWrite
        doc.transact(() => {
          for (const u of updates) { Y.applyUpdate(shadow, u); Y.applyUpdate(doc, u, 'srv') }
        }, 'srv')
        // upload whatever the server is missing (offline edits, or a brand-new workspace)
        const missing = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(shadow))
        ready = true
        st.status = 'connected'; st.error = null; st.everReady = true
        if (missing.length > 2 && !st.readOnly) sendUpdate(missing).catch(() => {})
        // keep the server log small: replace history with one encrypted snapshot
        if (m.entries.length > 50 && !st.readOnly) enqueue(async () => {
          const data = await seal(kk, Y.encodeStateAsUpdate(doc))
          sendJSON({ t: 'compact', upTo: lastSeq, data, sig: await signData(data) })
        })
        readyWaiters.forEach((f) => f()); readyWaiters = []
        h.onReady()
        h.emit()
      } else if (m.t === 'up') {
        lastSeq = Math.max(lastSeq, m.seq)
        try { Y.applyUpdate(doc, await unseal(kk, m.data), 'srv') } catch {}
      } else if (m.t === 'ack') {
        lastSeq = Math.max(lastSeq, m.seq)
        acks.shift()?.resolve()
      } else if (m.t === 'pres') {
        try { h.onAwareness(m.tab, await unseal(kk, m.data)) } catch {}
      } else if (m.t === 'leave') {
        h.onLeave(m.tab)
      } else if (m.t === 'pub') {
        // the workspace was just upgraded by an editor
        if (!signer) {
          signer = await loadSigner(m.pub)
          if (signer) { st.readOnly = !signer.canWrite; h.onSigner(signer); h.emit() }
        }
      } else if (m.t === 'error') {
        if (m.for === 'up') acks.shift()?.reject(new Error(m.error))
        else st.error = m.error
        h.emit()
      }
    }
    sock.onclose = () => {
      ready = false
      st.status = closed ? 'closed' : 'offline'
      // unacked updates are re-sent by the init diff after reconnecting
      acks.forEach((a) => a.reject(new Error('Connection to the sync server dropped.')))
      acks = []
      h.onDisconnect()
      h.emit()
      if (closed) return
      setTimeout(open, retry)
      retry = Math.min(retry * 2, 30000)
    }
  }
  function sendUpdate(u: Uint8Array): Promise<void> {
    if (st.readOnly) return Promise.reject(new Error('This link is view-only.'))
    if (!ready) return Promise.reject(new Error('Not connected to the sync server.'))
    return new Promise((resolve, reject) => {
      enqueue(async () => {
        const data = await seal(k as CryptoKey, u)
        const sig = await signData(data)
        if (!ready || sock?.readyState !== 1) return reject(new Error('Not connected to the sync server.'))
        acks.push({ resolve, reject })
        sock.send(JSON.stringify({ t: 'up', data, sig }))
      })
    })
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
    whenReady(timeoutMs = 15000): Promise<void> {
      if (ready) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(st.error || `Could not reach the sync server at ${url}.`)), timeoutMs)
        readyWaiters.push(() => { clearTimeout(t); resolve() })
      })
    },
    sendUpdate,
    /** awareness update (presence + cursors), encrypted */
    sendAwareness(update: Uint8Array) {
      if (ready) enqueue(async () => sendJSON({ t: 'pres', tab: tabId, data: await seal(k as CryptoKey, update) }))
    },
    close() { closed = true; sock?.close() },
    /** Encrypt and store a file (image) on the sync server. Returns its id. */
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
      if (!r.ok) throw new Error(r.status === 404 ? 'Image not found on the sync server.' : `Download failed (${r.status}).`)
      return unsealBytes(k as CryptoKey, new Uint8Array(await r.arrayBuffer()))
    },
  }
}
