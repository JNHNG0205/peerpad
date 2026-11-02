// Networking + persistence for one workspace.
//  - Yjs CRDT doc = source of truth (merges concurrent edits without conflicts)
//  - Trystero (WebRTC) = direct browser-to-browser sync; public Nostr relays are used
//    only to find peers, and the handshake is encrypted with the workspace key
//  - BroadcastChannel = instant sync between tabs of the same browser
//  - IndexedDB = offline copy, so the workspace survives reloads and works offline
import * as Y from 'yjs'
import { joinRoom, selfId } from 'trystero/nostr'

const APP_ID = 'peerpad-p2p-workspace-v1'
const tabId = Math.random().toString(36).slice(2, 10)

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

export function deleteLocal(ws) {
  openDB().then((db) => db.transaction('docs', 'readwrite').objectStore('docs').delete(ws)).catch(() => {})
}

/**
 * Connects doc to peers. Returns { peers: Map, setPresence(obj), status(), onChange(fn) }
 * peers: key -> { name, color, page, block, ts, via }
 */
export function connect(doc, ws, key) {
  const peers = new Map()
  const listeners = new Set()
  let presence = {}
  let p2pCount = 0
  let relayError = null
  const emit = () => listeners.forEach((f) => f())

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
        bc.postMessage({ t: 'pres', id: tabId, p: presence })
      } else if (m.t === 'pres') {
        peers.set('tab:' + m.id, { ...m.p, ts: Date.now(), via: 'tab' })
        emit()
      } else if (m.t === 'bye') {
        peers.delete('tab:' + m.id)
        emit()
      }
    }
    bc.postMessage({ t: 'sv', sv: Y.encodeStateVector(doc) })
    addEventListener('pagehide', () => bc.postMessage({ t: 'bye', id: tabId }))
  }

  // ---- WebRTC peers
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
      peers.delete('p2p:' + pid)
      emit()
    }
    // Peer tells us what it has -> we send exactly what it is missing.
    aSv.onMessage = (sv, { peerId }) =>
      aUp.send(Y.encodeStateAsUpdate(doc, new Uint8Array(sv)), { target: peerId })
    aUp.onMessage = (u) => Y.applyUpdate(doc, new Uint8Array(u), 'p2p')
    aPres.onMessage = (p, { peerId }) => {
      peers.set('p2p:' + peerId, { ...p, ts: Date.now(), via: 'p2p' })
      emit()
    }
  } catch (e) {
    relayError = String(e?.message || e)
  }

  // Relay every change to whichever transport it did not come from.
  // Yjs ignores updates it already has, so this can never loop.
  doc.on('update', (u, origin) => {
    if (origin !== 'p2p' && aUp && p2pCount) aUp.send(u).catch(() => {})
    if (origin !== 'bc' && bc) bc.postMessage({ t: 'up', u })
    scheduleSave()
  })

  const broadcastPresence = () => {
    if (aPres && p2pCount) aPres.send(presence).catch(() => {})
    if (bc) bc.postMessage({ t: 'pres', id: tabId, p: presence })
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
    selfId,
    peers,
    onChange: (f) => listeners.add(f),
    setPresence(p) {
      presence = p
      broadcastPresence()
    },
    status: () => ({ p2p: p2pCount, error: relayError }),
    leave: () => room?.leave(),
  }
}
