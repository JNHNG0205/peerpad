// Encrypted connection to a PeerPad sync server.
// Shared by the browser app and the MCP server (no browser-only APIs: works in Node 22+).
import * as Y from 'yjs'

export const newTabId = () => Math.random().toString(36).slice(2, 12)

/* ---------- end-to-end encryption (AES-GCM, key derived from the invite key) ---------- */
const te = new TextEncoder()
const td = new TextDecoder()
function b64(u8) {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
  return btoa(s)
}
function unb64(s) {
  const bin = atob(s)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}
async function deriveKey(key, ws) {
  const base = await crypto.subtle.importKey('raw', te.encode(key), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: te.encode('peerpad:' + ws), iterations: 150000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
async function seal(k, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, bytes))
  const out = new Uint8Array(12 + ct.length)
  out.set(iv)
  out.set(ct, 12)
  return b64(out)
}
async function unseal(k, s) {
  const u = unb64(s)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12) }, k, u.subarray(12)))
}
export const b64u = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const unb64u = (s) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))

/* ---------- write permission (ECDSA P-256) ----------
 * Edit links carry the private key (sk), view links only the public key (pk).
 * Every change is signed; the sync server and peers drop changes without a valid signature. */
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }
const SIG = { name: 'ECDSA', hash: 'SHA-256' }
export async function generateWriteKeys() {
  const kp = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey)
  return { pk: b64u(raw), sk: jwk.d }
}
/** Returns null (workspace without permissions) or { pk, canWrite, sign(bytes), verify(sig, bytes) }. */
export async function loadSigner(pk, sk) {
  if (!pk) return null
  const raw = unb64u(pk)
  const verifyKey = await crypto.subtle.importKey('raw', raw, ECDSA, false, ['verify'])
  const verify = async (sig, bytes) => { try { return await crypto.subtle.verify(SIG, verifyKey, sig, bytes) } catch { return false } }
  let signKey = null
  if (sk) {
    try {
      signKey = await crypto.subtle.importKey('jwk',
        { kty: 'EC', crv: 'P-256', d: sk, x: b64u(raw.slice(1, 33)), y: b64u(raw.slice(33, 65)), ext: true }, ECDSA, false, ['sign'])
      const probe = te.encode('peerpad-probe')
      if (!(await verify(new Uint8Array(await crypto.subtle.sign(SIG, signKey, probe)), probe))) signKey = null
    } catch { signKey = null }
  }
  return {
    pk,
    canWrite: !!signKey,
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign(SIG, signKey, bytes)),
    verify,
  }
}

async function roomHash(ws, key) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(`peerpad-room:${ws}:${key}`)))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * hooks: { emit, onReady, onPresence(tab, p), onLeave(tab), onDisconnect, onSigner(signer) }
 * signer: from loadSigner(), or null for a workspace without view-only links.
 * Returns { state, whenReady(), sendUpdate(u) -> Promise (resolves when the server stored it),
 *           sendPresence(p), close() }
 */
export function serverTransport(doc, ws, key, url, tabId, hooks = {}, signer = null) {
  const h = { emit() {}, onReady() {}, onPresence() {}, onLeave() {}, onDisconnect() {}, onSigner() {}, ...hooks }
  const st = { status: 'connecting', error: null, everReady: false, readOnly: !!signer && !signer.canWrite }
  const signData = async (data) => (signer?.canWrite ? b64u(await signer.sign(te.encode(data))) : undefined)
  let sock = null, k = null, room = null, ready = false, retry = 1000, lastSeq = 0, closed = false
  let acks = [] // resolvers for updates waiting for the server's ack (acks arrive in send order)
  let readyWaiters = []
  const sendJSON = (o) => sock?.readyState === 1 && sock.send(JSON.stringify(o))
  // Encryption is async; this chain keeps sends in the same order as the edits.
  let chain = Promise.resolve()
  const enqueue = (fn) => (chain = chain.then(fn, fn))

  async function start() {
    try {
      if (!globalThis.crypto?.subtle) throw new Error('Encryption needs HTTPS (or localhost).')
      k = await deriveKey(key, ws)
      room = await roomHash(ws, key)
      open()
    } catch (e) {
      st.status = 'error'; st.error = e.message; h.emit()
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
      let m
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : td.decode(ev.data)) } catch { return }
      if (m.t === 'init') {
        const shadow = new Y.Doc() // what the server already has
        const updates = []
        for (const e of m.entries) {
          try { updates.push(await unseal(k, e.data)) } catch { /* wrong key or corrupt entry */ }
        }
        if (m.entries.length && !updates.length) {
          st.status = 'error'; st.error = 'Could not decrypt this workspace. Check the invite link.'; h.emit(); return
        }
        lastSeq = m.seq
        // Permissions: the server remembers the workspace's public key.
        if (m.pub && signer && m.pub !== signer.pk) {
          st.status = 'error'; st.error = 'This link does not match the workspace. Ask for a new invite link.'; h.emit(); return
        }
        if (m.pub && !signer) {
          // An old link opening an upgraded workspace: it can still read, but no longer edit.
          signer = await loadSigner(m.pub)
          h.onSigner(signer)
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
          const data = await seal(k, Y.encodeStateAsUpdate(doc))
          sendJSON({ t: 'compact', upTo: lastSeq, data, sig: await signData(data) })
        })
        readyWaiters.forEach((f) => f()); readyWaiters = []
        h.onReady()
        h.emit()
      } else if (m.t === 'up') {
        lastSeq = Math.max(lastSeq, m.seq)
        try { Y.applyUpdate(doc, await unseal(k, m.data), 'srv') } catch {}
      } else if (m.t === 'ack') {
        lastSeq = Math.max(lastSeq, m.seq)
        acks.shift()?.resolve()
      } else if (m.t === 'pres') {
        try { h.onPresence(m.tab, JSON.parse(td.decode(await unseal(k, m.data)))) } catch {}
      } else if (m.t === 'leave') {
        h.onLeave(m.tab)
      } else if (m.t === 'pub') {
        // the workspace was just upgraded by an editor
        if (!signer) { signer = await loadSigner(m.pub); st.readOnly = !signer.canWrite; h.onSigner(signer); h.emit() }
      } else if (m.t === 'error') {
        if (m.for === 'up') acks.shift()?.reject(new Error(m.error))
        else st.error = m.error
        h.emit()
      }
    }
    sock.onclose = () => {
      ready = false
      st.status = closed ? 'closed' : 'offline'
      // Unacked updates are re-sent by the init diff after reconnecting.
      acks.forEach((a) => a.reject(new Error('Connection to the sync server dropped.')))
      acks = []
      h.onDisconnect()
      h.emit()
      if (closed) return
      setTimeout(open, retry)
      retry = Math.min(retry * 2, 30000)
    }
  }
  function sendUpdate(u) {
    if (st.readOnly) return Promise.reject(new Error('This link is view-only.'))
    if (!ready) return Promise.reject(new Error('Not connected to the sync server.'))
    return new Promise((resolve, reject) => {
      enqueue(async () => {
        const data = await seal(k, u)
        const sig = await signData(data)
        if (!ready || sock?.readyState !== 1) return reject(new Error('Not connected to the sync server.'))
        acks.push({ resolve, reject })
        sock.send(JSON.stringify({ t: 'up', data, sig }))
      })
    })
  }
  start()
  return {
    state: st,
    whenReady(timeoutMs = 15000) {
      if (ready) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(st.error || `Could not reach the sync server at ${url}.`)), timeoutMs)
        readyWaiters.push(() => { clearTimeout(t); resolve() })
      })
    },
    sendUpdate,
    sendPresence(p) {
      if (ready) enqueue(async () => sendJSON({ t: 'pres', tab: tabId, data: await seal(k, te.encode(JSON.stringify(p))) }))
    },
    close() { closed = true; sock?.close() },
  }
}
