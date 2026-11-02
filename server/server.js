// PeerPad sync server.
// - Keeps an always-on copy of each workspace so edits sync even when no teammate is online.
// - End-to-end encrypted: browsers encrypt every update with the workspace key before sending.
//   The server only stores and relays opaque blobs; it never sees page content, names, or keys.
// - Also serves the built web app (Next.js static export in out/), so one deploy = app + sync.
//
// Env: PORT (default 8787), DATA_DIR (default ./data), STATIC_DIR (default ../out)
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 8787
const DATA = path.resolve(process.env.DATA_DIR || path.join(here, '..', 'data'))
const STATIC = path.resolve(process.env.STATIC_DIR || path.join(here, '..', 'out'))
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
}
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
// ---------- encrypted file storage (images) ----------
// Browsers encrypt files with the workspace key before upload; the server stores opaque bytes.
const MAX_ASSET = 10 * 1024 * 1024
const ASSET_ID_RE = /^[A-Za-z0-9_-]{16,40}$/
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type, x-peerpad-sig',
  'access-control-max-age': '86400',
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
async function handleAsset(req, res, room, id) {
  const file = path.join(DATA, 'assets', room, id)
  if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end()
  if (req.method === 'GET') {
    try {
      const buf = await readFile(file)
      res.writeHead(200, { ...CORS, 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' })
      return res.end(buf)
    } catch { return res.writeHead(404, CORS).end('Not found') }
  }
  if (req.method === 'PUT') {
    let body
    try { body = await readBody(req, MAX_ASSET) } catch { return res.writeHead(413, CORS).end('File is larger than 10 MB.') }
    const r = await getRoom(room)
    try {
      if (r.pub) {
        // workspaces with view-only links: only editors (valid signature) may upload
        const verify = await verifier(r)
        const sig = String(req.headers['x-peerpad-sig'] || '')
        const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, r.verifyKey, unb64u(sig), body).catch(() => false)
        if (!verify || !ok) return res.writeHead(403, CORS).end('This link is view-only.')
      }
      try { await stat(file); return res.writeHead(409, CORS).end('Already exists') } catch {}
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, body)
      return res.writeHead(201, CORS).end('Stored')
    } finally {
      if (!r.clients.size && !r.timer) rooms.delete(room)
    }
  }
  res.writeHead(405, CORS).end()
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const asset = url.pathname.match(/\/assets\/([a-f0-9]{64})\/([^/]+)$/)
  if (asset) {
    if (!ASSET_ID_RE.test(asset[2])) return res.writeHead(400, CORS).end('Bad id')
    return handleAsset(req, res, asset[1], asset[2])
  }
  if (url.pathname.endsWith('/peerpad-health')) {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    return res.end(JSON.stringify({ peerpad: true, rooms: rooms.size }))
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    // static web app; anything unknown falls back to the app's index.html
    let rel = decodeURIComponent(url.pathname)
    if (rel.endsWith('/')) rel += 'index.html'
    let file = path.resolve(STATIC, '.' + rel)
    if (!file.startsWith(STATIC + path.sep)) return res.writeHead(400).end('Bad path')
    if (!existsSync(file) || !(await stat(file)).isFile()) {
      if (existsSync(file + '.html')) file += '.html'
      else if (!path.extname(rel)) file = path.join(STATIC, 'index.html')
      else return res.writeHead(404).end('Not found')
    }
    if (!existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end('PeerPad sync server is running. Build the app (npm run build) to serve it here.')
    }
    const immutable = rel.startsWith('/_next/static/')
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    return res.end(req.method === 'HEAD' ? undefined : await readFile(file))
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
