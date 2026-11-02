// PeerPad sync server.
// - Keeps an always-on copy of each workspace so edits sync even when no teammate is online.
// - End-to-end encrypted: browsers encrypt every update with the workspace key before sending.
//   The server only stores and relays opaque blobs; it never sees page content, names, or keys.
// - Also serves the built app (dist/index.html), so one deploy = app + sync.
//
// Env: PORT (default 8787), DATA_DIR (default ./data), STATIC_DIR (default ../dist)
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 8787
const DATA = path.resolve(process.env.DATA_DIR || path.join(here, '..', 'data'))
const STATIC = path.resolve(process.env.STATIC_DIR || path.join(here, '..', 'dist'))
const MAX_MSG = 10 * 1024 * 1024 // per message
const MAX_ROOM = 100 * 1024 * 1024 // per workspace on disk
const ROOM_RE = /^[a-f0-9]{64}$/
const PUB_RE = /^[A-Za-z0-9_-]{87}$/ // raw P-256 public key, base64url

// Workspaces with view-only links have a public key; every change must carry a valid signature.
const te = new TextEncoder()
const unb64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'))
async function verifier(r) {
  if (!r.pub) return null
  if (!r.verifyKey) r.verifyKey = await crypto.subtle.importKey('raw', unb64u(r.pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  return async (data, sig) => {
    if (typeof sig !== 'string') return false
    try { return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, r.verifyKey, unb64u(sig), te.encode(data)) } catch { return false }
  }
}

await mkdir(DATA, { recursive: true })

/** room -> { entries: [{seq, data}], seq, size, clients: Set, timer } */
const rooms = new Map()

async function getRoom(id) {
  let r = rooms.get(id)
  if (r) return r
  r = { entries: [], seq: 0, size: 0, pub: null, clients: new Set(), timer: null, loading: null }
  rooms.set(id, r)
  r.loading = (async () => {
    try {
      const saved = JSON.parse(await readFile(path.join(DATA, id + '.json'), 'utf8'))
      r.entries = saved.entries || []
      r.seq = saved.seq || 0
      r.pub = saved.pub || null
      r.size = r.entries.reduce((s, e) => s + e.data.length, 0)
    } catch {}
  })()
  await r.loading
  return r
}

function scheduleSave(id, r) {
  clearTimeout(r.timer)
  r.timer = setTimeout(async () => {
    r.timer = null
    const file = path.join(DATA, id + '.json')
    try {
      await writeFile(file + '.tmp', JSON.stringify({ seq: r.seq, pub: r.pub, entries: r.entries }))
      await rename(file + '.tmp', file)
    } catch (e) {
      console.error('save failed', id.slice(0, 8), e.message)
    }
    if (!r.clients.size) rooms.delete(id)
  }, 800)
}

const send = (sock, obj) => sock.readyState === 1 && sock.send(JSON.stringify(obj))
const broadcast = (r, from, obj) => {
  const s = JSON.stringify(obj)
  for (const c of r.clients) if (c !== from && c.readyState === 1) c.send(s)
}

// ---------- HTTP: health + static app ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname.endsWith('/peerpad-health')) {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    return res.end(JSON.stringify({ peerpad: true, rooms: rooms.size }))
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const file = path.join(STATIC, 'index.html')
    if (existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
      return res.end(await readFile(file))
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end('PeerPad sync server is running. Build the app (npm run build) to serve it here.')
  }
  res.writeHead(404).end('Not found')
})

// ---------- WebSocket sync ----------
const wss = new WebSocketServer({ server, path: '/sync', maxPayload: MAX_MSG })

wss.on('connection', async (sock, req) => {
  const id = new URL(req.url, 'http://x').searchParams.get('room') || ''
  if (!ROOM_RE.test(id)) return sock.close(1008, 'bad room')
  const r = await getRoom(id)
  r.clients.add(sock)
  sock.isAlive = true
  sock.on('pong', () => (sock.isAlive = true))
  send(sock, { t: 'init', entries: r.entries, seq: r.seq, pub: r.pub })

  // Signature checks are async; handle each socket's messages strictly in order so acks match.
  let queue = Promise.resolve()
  sock.on('message', (raw) => { queue = queue.then(() => handle(raw)).catch((e) => console.error('message error', e.message)) })

  async function handle(raw) {
    let m
    try { m = JSON.parse(raw) } catch { return }
    if ((m.t === 'up' || m.t === 'compact') && r.pub) {
      const verify = await verifier(r)
      if (!(await verify(m.data, m.sig))) return send(sock, { t: 'error', for: m.t, error: 'This link is view-only. Ask for an edit link to make changes.' })
    }
    if (m.t === 'up' && typeof m.data === 'string') {
      if (r.size + m.data.length > MAX_ROOM) return send(sock, { t: 'error', for: 'up', error: 'Workspace is over the storage limit.' })
      const e = { seq: ++r.seq, data: m.data }
      r.entries.push(e)
      r.size += m.data.length
      broadcast(r, sock, { t: 'up', ...e })
      send(sock, { t: 'ack', seq: e.seq })
      scheduleSave(id, r)
    } else if (m.t === 'compact' && typeof m.data === 'string' && Number.isInteger(m.upTo)) {
      // Replace entries up to `upTo` with one encrypted snapshot of the whole doc.
      if (m.upTo > r.seq) return
      const rest = r.entries.filter((e) => e.seq > m.upTo)
      r.entries = [{ seq: m.upTo, data: m.data }, ...rest]
      r.size = r.entries.reduce((s, e) => s + e.data.length, 0)
      scheduleSave(id, r)
    } else if (m.t === 'pres' && typeof m.data === 'string' && typeof m.tab === 'string') {
      sock.tab = m.tab.slice(0, 32)
      broadcast(r, sock, { t: 'pres', tab: sock.tab, data: m.data })
    } else if (m.t === 'claim' && typeof m.pub === 'string' && PUB_RE.test(m.pub)) {
      // First editor with keys turns on view-only links for this workspace (one time).
      if (r.pub && r.pub !== m.pub) return send(sock, { t: 'error', error: 'This workspace already has a different owner key.' })
      if (!r.pub) {
        try { await crypto.subtle.importKey('raw', unb64u(m.pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']) }
        catch { return send(sock, { t: 'error', error: 'Invalid owner key.' }) }
        r.pub = m.pub
        r.verifyKey = null
        scheduleSave(id, r)
        broadcast(r, sock, { t: 'pub', pub: r.pub })
      }
    }
  }

  sock.on('close', () => {
    r.clients.delete(sock)
    if (sock.tab) broadcast(r, sock, { t: 'leave', tab: sock.tab })
    if (!r.clients.size && !r.timer) rooms.delete(id)
  })
})

// drop dead connections
setInterval(() => {
  for (const s of wss.clients) {
    if (!s.isAlive) { s.terminate(); continue }
    s.isAlive = false
    s.ping()
  }
}, 30000)

server.listen(PORT, () => console.log(`PeerPad sync server on :${PORT}  data=${DATA}`))
