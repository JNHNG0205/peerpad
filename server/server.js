// PeerPad server.
// - Stores and relays end-to-end encrypted workspace updates: browsers encrypt every update with the
//   workspace key before sending, so the server never sees page content, names or keys.
// - A workspace is several documents: "root" (page list, titles) and one per page, loaded on demand.
//   Each document's history is append-only rows in SQLite; editors' browsers periodically replace old
//   rows with one encrypted snapshot (compaction), since only they can read the content.
// - Also serves the built web app (Next.js static export in out/) and encrypted files (images).
//
// Env: PORT (8787), DATA_DIR (./data), STATIC_DIR (../out), MCP_UPSTREAM (optional, forwards /mcp)
import { createServer, request as httpRequest } from 'node:http'
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
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
const MAX_ROOM = 200 * 1024 * 1024 // per workspace (all documents), excluding files
const ROOM_RE = /^[a-f0-9]{64}$/
const DOC_RE = /^(root|[A-Za-z0-9_-]{1,40})$/
const PUB_RE = /^[A-Za-z0-9_-]{87}$/ // raw P-256 public key, base64url
const COMPACT_GAP_MS = 20_000 // ignore another compaction of the same document within this window
const PRES_PER_SEC = 30 // presence messages allowed per connection per second

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

/* ---------- storage: SQLite, append-only rows per document ---------- */
const db = new DatabaseSync(path.join(DATA, 'peerpad.db'))
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS rooms (room TEXT PRIMARY KEY, pub TEXT);
  CREATE TABLE IF NOT EXISTS updates (
    room TEXT NOT NULL, doc TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (room, doc, seq)
  ) WITHOUT ROWID;
`)
const q = {
  pub: db.prepare('SELECT pub FROM rooms WHERE room = ?'),
  setPub: db.prepare('INSERT INTO rooms (room, pub) VALUES (?, ?) ON CONFLICT(room) DO UPDATE SET pub = excluded.pub'),
  docInfo: db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq, COUNT(*) AS n FROM updates WHERE room = ? AND doc = ?'),
  roomSize: db.prepare('SELECT COALESCE(SUM(LENGTH(data)), 0) AS size, COUNT(*) AS n FROM updates WHERE room = ?'),
  entries: db.prepare('SELECT seq, data FROM updates WHERE room = ? AND doc = ? ORDER BY seq'),
  insert: db.prepare('INSERT INTO updates (room, doc, seq, data) VALUES (?, ?, ?, ?)'),
  trim: db.prepare('DELETE FROM updates WHERE room = ? AND doc = ? AND seq <= ?'),
  drop: db.prepare('DELETE FROM updates WHERE room = ? AND doc = ?'),
}
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } }

/** Workspaces saved by earlier versions (one JSON file each) become the "root" document. */
async function importLegacy(room) {
  const file = path.join(DATA, room + '.json')
  if (!existsSync(file)) return
  if (q.roomSize.get(room).n > 0) return
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'))
    tx(() => {
      for (const e of saved.entries || []) q.insert.run(room, 'root', e.seq, e.data)
      if (saved.pub) q.setPub.run(room, saved.pub)
    })
    await rename(file, file + '.imported')
    console.log(`imported workspace ${room.slice(0, 8)} (${(saved.entries || []).length} entries)`)
  } catch (e) {
    console.error('import failed', room.slice(0, 8), e.message)
  }
}

/** room -> { pub, verifyKey, size, clients: Set<socket>, docs: Map<doc, { seq, n, lastCompact, subs: Set<socket> }> } */
const rooms = new Map()
async function getRoom(id) {
  let r = rooms.get(id)
  if (r) return r.ready ? r : (await r.loading, r)
  r = { pub: null, verifyKey: null, size: 0, clients: new Set(), docs: new Map(), ready: false }
  rooms.set(id, r)
  r.loading = (async () => {
    await importLegacy(id)
    r.pub = q.pub.get(id)?.pub || null
    r.size = q.roomSize.get(id).size
    r.ready = true
  })()
  await r.loading
  return r
}
function docOf(r, room, d) {
  let doc = r.docs.get(d)
  if (!doc) {
    const info = q.docInfo.get(room, d)
    doc = { seq: info.seq, n: info.n, lastCompact: 0, subs: new Set() }
    r.docs.set(d, doc)
  }
  return doc
}
const releaseRoom = (id, r) => { if (!r.clients.size) rooms.delete(id) }

const send = (sock, obj) => sock.readyState === 1 && sock.send(JSON.stringify(obj))
const broadcast = (set, from, obj) => {
  const s = JSON.stringify(obj)
  for (const c of set) if (c !== from && c.readyState === 1) c.send(s)
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
      releaseRoom(room, r)
    }
  }
  res.writeHead(405, CORS).end()
}

// Optional: forward /mcp/* to the AI connector service (MCP_UPSTREAM, e.g. http://127.0.0.1:3333).
// Caddy does this routing in the Docker setup; this covers hosts without a reverse proxy.
const MCP_UPSTREAM = process.env.MCP_UPSTREAM ? new URL(process.env.MCP_UPSTREAM) : null
function proxyMcp(req, res) {
  const up = httpRequest({
    hostname: MCP_UPSTREAM.hostname, port: MCP_UPSTREAM.port, path: req.url, method: req.method,
    headers: { ...req.headers, 'x-forwarded-host': req.headers.host, 'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http' },
  }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res) })
  up.on('error', () => { if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'AI connections are not enabled on this server.' })) })
  req.pipe(up)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (MCP_UPSTREAM && (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/'))) return proxyMcp(req, res)
  const asset = url.pathname.match(/\/assets\/([a-f0-9]{64})\/([^/]+)$/)
  if (asset) {
    if (!ASSET_ID_RE.test(asset[2])) return res.writeHead(400, CORS).end('Bad id')
    return handleAsset(req, res, asset[1], asset[2])
  }
  if (url.pathname.endsWith('/peerpad-health')) {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
    return res.end(JSON.stringify({ peerpad: true, rooms: rooms.size, protocol: 2 }))
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
// Protocol (JSON messages; "d" names a document: "root" or a page id):
//   client: sub{d} unsub{d} up{d,data,sig} compact{d,upTo,data,sig} drop{d,sig} pres{tab,data} claim{pub}
//   server: init{d,entries,seq,n,pub} up{d,seq,data} ack{d,seq,n} compacted{d} dropped{d} pres leave pub error
// Connections without ?v=2 (older app versions) get the root document automatically.
const wss = new WebSocketServer({ server, path: '/sync', maxPayload: MAX_MSG })

wss.on('connection', async (sock, req) => {
  const params = new URL(req.url, 'http://x').searchParams
  const id = params.get('room') || ''
  if (!ROOM_RE.test(id)) return sock.close(1008, 'bad room')
  const legacyClient = params.get('v') !== '2'
  const r = await getRoom(id)
  r.clients.add(sock)
  sock.subs = new Set()
  sock.isAlive = true
  sock.pres = { t: 0, n: 0 }
  sock.on('pong', () => (sock.isAlive = true))

  const subscribe = (d) => {
    const doc = docOf(r, id, d)
    doc.subs.add(sock)
    sock.subs.add(d)
    const entries = q.entries.all(id, d).map((e) => ({ seq: e.seq, data: e.data }))
    send(sock, { t: 'init', d, entries, seq: doc.seq, n: doc.n, pub: r.pub }) // older app versions ignore d and n
  }
  if (legacyClient) subscribe('root')

  // Signature checks are async; handle each socket's messages strictly in order so acks match.
  let queue = Promise.resolve()
  sock.on('message', (raw) => { queue = queue.then(() => handle(raw)).catch((e) => console.error('message error', e.message)) })

  async function handle(raw) {
    let m
    try { m = JSON.parse(raw) } catch { return }
    const d = m.d === undefined ? 'root' : m.d
    if (!DOC_RE.test(String(d))) return send(sock, { t: 'error', d, error: 'Bad document id.' })
    if ((m.t === 'up' || m.t === 'compact') && r.pub) {
      const verify = await verifier(r)
      if (!(await verify(m.data, m.sig))) return send(sock, { t: 'error', for: m.t, d, error: 'This link is view-only. Ask for an edit link to make changes.' })
    }
    if (m.t === 'sub') {
      if (!sock.subs.has(d)) subscribe(d)
    } else if (m.t === 'unsub') {
      sock.subs.delete(d)
      r.docs.get(d)?.subs.delete(sock)
    } else if (m.t === 'up' && typeof m.data === 'string') {
      if (r.size + m.data.length > MAX_ROOM) return send(sock, { t: 'error', for: 'up', d, error: 'Workspace is over the storage limit.' })
      const doc = docOf(r, id, d)
      const seq = ++doc.seq
      q.insert.run(id, d, seq, m.data)
      doc.n++
      r.size += m.data.length
      broadcast(doc.subs, sock, { t: 'up', d, seq, data: m.data })
      send(sock, { t: 'ack', d, seq, n: doc.n })
    } else if (m.t === 'compact' && typeof m.data === 'string' && Number.isInteger(m.upTo)) {
      // Replace rows up to `upTo` with one encrypted snapshot of the whole document.
      const doc = docOf(r, id, d)
      if (m.upTo > doc.seq || m.upTo < 1 || Date.now() - doc.lastCompact < COMPACT_GAP_MS) return send(sock, { t: 'compacted', d, skipped: true })
      doc.lastCompact = Date.now()
      tx(() => { q.trim.run(id, d, m.upTo); q.insert.run(id, d, m.upTo, m.data) })
      const info = q.docInfo.get(id, d)
      doc.n = info.n
      r.size = q.roomSize.get(id).size
      send(sock, { t: 'compacted', d, n: doc.n })
    } else if (m.t === 'drop' && d !== 'root') {
      // a deleted page: remove its history (editors only on workspaces with view-only links)
      if (r.pub) {
        const verify = await verifier(r)
        if (!(await verify('drop:' + d, m.sig))) return send(sock, { t: 'error', for: 'drop', d, error: 'This link is view-only.' })
      }
      q.drop.run(id, d)
      r.docs.delete(d)
      r.size = q.roomSize.get(id).size
      broadcast(r.clients, null, { t: 'dropped', d })
    } else if (m.t === 'pres' && typeof m.data === 'string' && typeof m.tab === 'string') {
      // presence and cursors: workspace-wide, rate limited per connection
      const now = Date.now()
      if (now - sock.pres.t > 1000) sock.pres = { t: now, n: 0 }
      if (++sock.pres.n > PRES_PER_SEC) return
      sock.tab = m.tab.slice(0, 32)
      broadcast(r.clients, sock, { t: 'pres', tab: sock.tab, data: m.data })
    } else if (m.t === 'claim' && typeof m.pub === 'string' && PUB_RE.test(m.pub)) {
      // First editor with keys turns on view-only links for this workspace (one time).
      if (r.pub && r.pub !== m.pub) return send(sock, { t: 'error', error: 'This workspace already has a different owner key.' })
      if (!r.pub) {
        try { await crypto.subtle.importKey('raw', unb64u(m.pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']) }
        catch { return send(sock, { t: 'error', error: 'Invalid owner key.' }) }
        r.pub = m.pub
        r.verifyKey = null
        q.setPub.run(id, r.pub)
        broadcast(r.clients, sock, { t: 'pub', pub: r.pub })
      }
    }
  }

  sock.on('close', () => {
    r.clients.delete(sock)
    for (const d of sock.subs) r.docs.get(d)?.subs.delete(sock)
    if (sock.tab) broadcast(r.clients, sock, { t: 'leave', tab: sock.tab })
    releaseRoom(id, r)
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

server.listen(PORT, () => console.log(`PeerPad server on :${PORT}  data=${DATA}`))
