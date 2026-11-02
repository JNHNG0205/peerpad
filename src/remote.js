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
async function roomHash(ws, key) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(`peerpad-room:${ws}:${key}`)))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * hooks: { emit, onReady, onPresence(tab, p), onLeave(tab), onDisconnect }
 * Returns { state, whenReady(), sendUpdate(u) -> Promise (resolves when the server stored it),
 *           sendPresence(p), close() }
 */
export function serverTransport(doc, ws, key, url, tabId, hooks = {}) {
  const h = { emit() {}, onReady() {}, onPresence() {}, onLeave() {}, onDisconnect() {}, ...hooks }
  const st = { status: 'connecting', error: null, everReady: false }
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
        doc.transact(() => {
          for (const u of updates) { Y.applyUpdate(shadow, u); Y.applyUpdate(doc, u, 'srv') }
        }, 'srv')
        // upload whatever the server is missing (offline edits, or a brand-new workspace)
        const missing = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(shadow))
        ready = true
        st.status = 'connected'; st.error = null; st.everReady = true
        if (missing.length > 2) sendUpdate(missing)
        // keep the server log small: replace history with one encrypted snapshot
        if (m.entries.length > 50) enqueue(async () => sendJSON({ t: 'compact', upTo: lastSeq, data: await seal(k, Y.encodeStateAsUpdate(doc)) }))
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
      } else if (m.t === 'error') {
        st.error = m.error
        acks.shift()?.reject(new Error(m.error))
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
    if (!ready) return Promise.reject(new Error('Not connected to the sync server.'))
    return new Promise((resolve, reject) => {
      enqueue(async () => {
        const data = await seal(k, u)
        if (!ready || sock?.readyState !== 1) return reject(new Error('Not connected to the sync server.'))
        acks.push({ resolve, reject })
        sock.send(JSON.stringify({ t: 'up', data }))
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
