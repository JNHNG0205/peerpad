// Networking + persistence for one workspace.
//  - Yjs CRDT doc = source of truth (merges concurrent edits without conflicts)
//  - Sync server (optional) = always-on encrypted copy; edits sync even when nobody else is online
//  - Trystero (WebRTC) = direct browser-to-browser sync; public Nostr relays are used
//    only to find peers, and the handshake is encrypted with the workspace key
//  - BroadcastChannel = instant sync between tabs of the same browser
//  - IndexedDB = offline copy, so the workspace survives reloads and works offline
import * as Y from 'yjs'
import { joinRoom } from 'trystero/nostr'
import { serverTransport, newTabId, loadSigner } from './remote.js'
export { generateWriteKeys, loadSigner } from './remote.js'

const APP_ID = 'peerpad-p2p-workspace-v1'
const tabId = newTabId()

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

/**
 * Connects doc to peers. Returns { peers: Map, setPresence(obj), status(), onChange(fn) }
 * peers: tabId -> { name, color, page, block, ts, via }
 */
export function connect(doc, ws, key, serverUrl = null, signer = null) {
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

  const readOnly = () => !!signer && !signer.canWrite

  // ---- sync server
  const srv = serverUrl
    ? serverTransport(doc, ws, key, serverUrl, tabId, {
        emit,
        onSigner: (s) => { signer = s; emit() },
        onReady: () => srv.sendPresence(presence),
        onPresence: (tab, p) => setPeer(tab, p, 'srv'),
        onLeave: (tab) => { if (peers.get(tab)?.via === 'srv') { peers.delete(tab); emit() } },
        onDisconnect: () => { for (const [t, p] of peers) if (p.via === 'srv') peers.delete(t) },
      }, signer)
    : null

  // P2P packets: [64-byte signature][Yjs update] when the workspace has view-only links.
  // Viewers cannot sign, so they never send changes; everyone drops unsigned changes.
  async function p2pSend(u, opts) {
    if (!aUp) return
    if (!signer) return aUp.send(u, opts).catch(() => {})
    if (!signer.canWrite) return
    const sig = await signer.sign(u)
    const pkt = new Uint8Array(64 + u.length)
    pkt.set(sig); pkt.set(u, 64)
    aUp.send(pkt, opts).catch(() => {})
  }
  async function p2pReceive(data) {
    const pkt = new Uint8Array(data)
    try {
      if (!signer) return Y.applyUpdate(doc, pkt, 'p2p')
      const sig = pkt.subarray(0, 64), u = pkt.subarray(64)
      if (await signer.verify(sig, u)) Y.applyUpdate(doc, u, 'p2p')
    } catch { /* malformed or from an older version */ }
  }

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
    aSv.onMessage = (sv, { peerId }) => p2pSend(Y.encodeStateAsUpdate(doc, new Uint8Array(sv)), { target: peerId })
    aUp.onMessage = (u) => p2pReceive(u)
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
    if (origin !== 'p2p' && aUp && p2pCount) p2pSend(u)
    if (origin !== 'bc' && bc) bc.postMessage({ t: 'up', u })
    if (origin !== 'srv' && srv && srv.state.status === 'connected' && !readOnly()) srv.sendUpdate(u).catch(() => {})
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
    status: () => ({ p2p: p2pCount, error: relayError, server: srv ? srv.state.status : null, serverError: srv?.state.error, readOnly: readOnly() }),
    leave: () => room?.leave(),
    /** Encrypted file storage on the sync server; null without a server. */
    assets: srv ? { upload: (bytes) => srv.uploadAsset(bytes), fetch: (id) => srv.fetchAsset(id) } : null,
  }
}
