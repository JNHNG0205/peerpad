// Networking + persistence for one workspace.
//  - Yjs CRDT doc = source of truth (merges concurrent edits without conflicts)
//  - Sync server (optional) = always-on encrypted copy; edits sync even when nobody else is online
//  - Trystero (WebRTC) = direct browser-to-browser sync; public Nostr relays are used
//    only to find peers, and the handshake is encrypted with the workspace key
//  - BroadcastChannel = instant sync between tabs of the same browser
//  - IndexedDB = offline copy, so the workspace survives reloads and works offline
import * as Y from 'yjs'
import { joinRoom } from 'trystero/nostr'

const APP_ID = 'peerpad-p2p-workspace-v1'
const tabId = Math.random().toString(36).slice(2, 12)

/* ---------- IndexedDB ---------- */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('peerpad', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('docs')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
export async function loadLocal(doc, ws) {
  try {
    const db = await openDB()
    const data = await new Promise((res) => {
      const q = db.transaction('docs').objectStore('docs').get(ws)
      q.onsuccess = () => res(q.result)
      q.onerror = () => res(null)
    })
    if (data) Y.applyUpdate(doc, data, 'idb')
    return !!data
  } catch {
    return false
  }
}
function saveLocal(doc, ws) {
  openDB()
    .then((db) => db.transaction('docs', 'readwrite').objectStore('docs').put(Y.encodeStateAsUpdate(doc), ws))
    .catch(() => {})
}

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

/* ---------- sync server transport ---------- */
function serverTransport(doc, ws, key, url, hooks) {
  const st = { status: 'connecting', error: null }
  let sock = null, k = null, room = null, ready = false, retry = 1000, lastSeq = 0
  const sendJSON = (o) => sock?.readyState === 1 && sock.send(JSON.stringify(o))

  async function start() {
    try {
      if (!crypto.subtle) throw new Error('Encryption needs HTTPS (or localhost).')
      k = await deriveKey(key, ws)
      room = await roomHash(ws, key)
      open()
    } catch (e) {
      st.status = 'error'; st.error = e.message; hooks.emit()
    }
  }
  function open() {
    let u
    try {
      u = new URL(url)
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
      u.pathname = u.pathname.replace(/\/+$/, '') + '/sync'
      u.search = '?room=' + room
      sock = new WebSocket(u)
    } catch (e) {
      st.status = 'error'; st.error = 'Invalid sync server address.'; hooks.emit(); return
    }
    st.status = 'connecting'; hooks.emit()
    sock.onopen = () => { retry = 1000 }
    sock.onmessage = async (ev) => {
      let m
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.t === 'init') {
        const shadow = new Y.Doc() // what the server already has
        const updates = []
        for (const e of m.entries) {
          try { updates.push(await unseal(k, e.data)) } catch { /* wrong key or corrupt entry */ }
        }
        lastSeq = m.seq
        doc.transact(() => {
          for (const u of updates) { Y.applyUpdate(shadow, u); Y.applyUpdate(doc, u, 'srv') }
        }, 'srv')
        // upload whatever the server is missing (offline edits, or a brand-new workspace)
        const missing = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(shadow))
        ready = true
        st.status = 'connected'; st.error = null
        if (missing.length > 2) sendJSON({ t: 'up', data: await seal(k, missing) })
        // keep the server log small: replace history with one encrypted snapshot
        if (m.entries.length > 50) sendJSON({ t: 'compact', upTo: lastSeq, data: await seal(k, Y.encodeStateAsUpdate(doc)) })
        hooks.onReady()
        hooks.emit()
      } else if (m.t === 'up') {
        lastSeq = Math.max(lastSeq, m.seq)
        try { Y.applyUpdate(doc, await unseal(k, m.data), 'srv') } catch {}
      } else if (m.t === 'ack') {
        lastSeq = Math.max(lastSeq, m.seq)
      } else if (m.t === 'pres') {
        try { hooks.onPresence(m.tab, JSON.parse(td.decode(await unseal(k, m.data)))) } catch {}
      } else if (m.t === 'leave') {
        hooks.onLeave(m.tab)
      } else if (m.t === 'error') {
        st.error = m.error; hooks.emit()
      }
    }
    sock.onclose = () => {
      ready = false
      st.status = 'offline'
      hooks.onDisconnect()
      hooks.emit()
      setTimeout(open, retry)
      retry = Math.min(retry * 2, 30000)
    }
  }
  start()
  return {
    state: st,
    async sendUpdate(u) { if (ready) sendJSON({ t: 'up', data: await seal(k, u) }) },
    async sendPresence(p) { if (ready) sendJSON({ t: 'pres', tab: tabId, data: await seal(k, te.encode(JSON.stringify(p))) }) },
  }
}

/**
 * Connects doc to peers. Returns { peers: Map, setPresence(obj), status(), onChange(fn) }
 * peers: tabId -> { name, color, page, block, ts, via }
 */
export function connect(doc, ws, key, serverUrl = null) {
  const peers = new Map()
  const listeners = new Set()
  let presence = { tab: tabId }
  let p2pCount = 0
  let relayError = null
  const emit = () => listeners.forEach((f) => f())
  const setPeer = (tab, p, via) => {
    if (!tab || tab === tabId) return
    peers.set(tab, { ...p, ts: Date.now(), via })
    emit()
  }

  // ---- persistence
  let saveTimer
  const scheduleSave = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => saveLocal(doc, ws), 400)
  }
  addEventListener('pagehide', () => saveLocal(doc, ws))

  // ---- same-browser tabs
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('peerpad:' + ws) : null
  if (bc) {
    bc.onmessage = ({ data: m }) => {
      if (m.t === 'up') Y.applyUpdate(doc, m.u, 'bc')
      else if (m.t === 'sv') {
        bc.postMessage({ t: 'up', u: Y.encodeStateAsUpdate(doc, m.sv) })
        if (!m.reply) bc.postMessage({ t: 'sv', sv: Y.encodeStateVector(doc), reply: true })
        bc.postMessage({ t: 'pres', p: presence })
      } else if (m.t === 'pres') setPeer(m.p.tab, m.p, 'tab')
      else if (m.t === 'bye') { peers.delete(m.tab); emit() }
    }
    bc.postMessage({ t: 'sv', sv: Y.encodeStateVector(doc) })
    addEventListener('pagehide', () => bc.postMessage({ t: 'bye', tab: tabId }))
  }

  // ---- sync server
  const srv = serverUrl
    ? serverTransport(doc, ws, key, serverUrl, {
        emit,
        onReady: () => srv.sendPresence(presence),
        onPresence: (tab, p) => setPeer(tab, p, 'srv'),
        onLeave: (tab) => { if (peers.get(tab)?.via === 'srv') { peers.delete(tab); emit() } },
        onDisconnect: () => { for (const [t, p] of peers) if (p.via === 'srv') peers.delete(t) },
      })
    : null

  // ---- WebRTC peers
  const p2pTabs = new Map() // trystero peerId -> tabId
  let room = null
  let aSv, aUp, aPres
  try {
    room = joinRoom({ appId: APP_ID, password: key }, ws, {
      onJoinError: (d) => { relayError = d.error; emit() },
    })
    aSv = room.makeAction('sv')
    aUp = room.makeAction('up')
    aPres = room.makeAction('pres')
    room.onPeerJoin = (pid) => {
      p2pCount++
      aSv.send(Y.encodeStateVector(doc), { target: pid })
      aPres.send(presence, { target: pid })
      emit()
    }
    room.onPeerLeave = (pid) => {
      p2pCount = Math.max(0, p2pCount - 1)
      const tab = p2pTabs.get(pid)
      if (tab && peers.get(tab)?.via === 'p2p') peers.delete(tab)
      p2pTabs.delete(pid)
      emit()
    }
    // Peer tells us what it has -> we send exactly what it is missing.
    aSv.onMessage = (sv, { peerId }) =>
      aUp.send(Y.encodeStateAsUpdate(doc, new Uint8Array(sv)), { target: peerId })
    aUp.onMessage = (u) => Y.applyUpdate(doc, new Uint8Array(u), 'p2p')
    aPres.onMessage = (p, { peerId }) => {
      p2pTabs.set(peerId, p.tab)
      setPeer(p.tab, p, 'p2p')
    }
  } catch (e) {
    relayError = String(e?.message || e)
  }

  // Relay every change to the transports it did not come from.
  // Yjs ignores updates it already has, so this can never loop.
  doc.on('update', (u, origin) => {
    if (origin !== 'p2p' && aUp && p2pCount) aUp.send(u).catch(() => {})
    if (origin !== 'bc' && bc) bc.postMessage({ t: 'up', u })
    if (origin !== 'srv' && srv) srv.sendUpdate(u)
    scheduleSave()
  })

  const broadcastPresence = () => {
    if (aPres && p2pCount) aPres.send(presence).catch(() => {})
    if (bc) bc.postMessage({ t: 'pres', p: presence })
    srv?.sendPresence(presence)
  }

  // heartbeat + expiry
  setInterval(() => {
    broadcastPresence()
    const now = Date.now()
    let changed = false
    for (const [k, p] of peers) if (now - p.ts > 25000) { peers.delete(k); changed = true }
    if (changed) emit()
  }, 8000)

  return {
    peers,
    onChange: (f) => listeners.add(f),
    setPresence(p) {
      presence = { ...p, tab: tabId }
      broadcastPresence()
    },
    status: () => ({ p2p: p2pCount, error: relayError, server: srv ? srv.state.status : null, serverError: srv?.state.error }),
    leave: () => room?.leave(),
  }
}
