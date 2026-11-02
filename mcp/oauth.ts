// OAuth 2.1 for AI apps (the sign-in flow MCP clients such as Claude and Codex use):
//   1. the app registers itself (dynamic client registration)
//   2. the person approves it in PeerPad's approval page (/oauth/authorize, in their browser, which
//      holds the workspace keys) and picks workspaces + access; the browser sends the workspace links here
//   3. the app exchanges the one-time code (with PKCE) for an access token and a refresh token
// Each approved workspace link is stored encrypted twice: with the access token's secret and with the
// refresh token's secret. Only hashes of those secrets are kept, so the stored file reveals nothing;
// the server can open a workspace only while the app presents a valid token.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { seal, open, type Invite } from './connectors.ts'
import type { AgentAccess, AgentConnection, AgentKind } from '../lib/agents.ts'

const ACCESS_TTL = 60 * 60 * 1000 // 1 hour; apps refresh automatically
const REFRESH_TTL = 60 * 24 * 60 * 60 * 1000 // 60 days, renewed on every refresh
const CODE_TTL = 5 * 60 * 1000
const PENDING_TTL = 10 * 60 * 1000

const b64u = (b: Buffer) => b.toString('base64url')
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }
const secret = () => b64u(randomBytes(32))

export class OAuthError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status }
}

type Client = { client_id: string; client_name: string; redirect_uris: string[]; created: number }
type Entry = { id: string; pk: string | null; access: AgentAccess; label: string; blobA: string; blobR: string; revoked?: boolean }
type Grant = {
  id: string; clientId: string; clientName: string; agent: AgentKind; createdAt: number; lastUsedAt: number | null
  revokeHash: string; accessHash: string | null; accessExp: number; refreshHash: string | null; refreshExp: number
  entries: Entry[]
}
type Pending = { grantId: string; invites: { entryId: string; invite: Invite; access: AgentAccess; label: string }[]; clientId: string; redirectUri: string; challenge: string; resource: string | null; expires: number }

/** Redirect addresses: https anywhere, or http on this computer (desktop apps listen on a local port). */
function validRedirect(u: string): boolean {
  try {
    const x = new URL(u)
    if (x.hash) return false
    if (x.protocol === 'https:') return true
    return x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)
  } catch { return false }
}
/** Loopback redirects may use any port (RFC 8252); everything else must match exactly. */
function redirectMatches(registered: string[], given: string): boolean {
  return registered.some((r) => {
    if (r === given) return true
    try {
      const a = new URL(r), b = new URL(given)
      const loop = (h: string) => ['localhost', '127.0.0.1', '[::1]'].includes(h)
      return a.protocol === 'http:' && loop(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search
    } catch { return false }
  })
}
export function agentKindOf(name: string): AgentKind {
  return /claude/i.test(name) ? 'claude' : /codex/i.test(name) ? 'codex' : 'other' // ChatGPT and others: generic icon
}

export class OAuthStore {
  private file: string
  private clients = new Map<string, Client>()
  private grants = new Map<string, Grant>()
  private codes = new Map<string, Pending>()
  private saving: Promise<void> = Promise.resolve()
  constructor(dataDir: string) { this.file = path.join(dataDir, 'oauth.json') }

  async load() {
    await mkdir(path.dirname(this.file), { recursive: true })
    try {
      const j = JSON.parse(await readFile(this.file, 'utf8'))
      for (const c of j.clients || []) this.clients.set(c.client_id, c)
      for (const g of j.grants || []) this.grants.set(g.id, g)
    } catch {}
    setInterval(() => this.sweep(), 60_000).unref()
  }
  private save() {
    this.saving = this.saving.then(async () => {
      const tmp = this.file + '.tmp'
      await writeFile(tmp, JSON.stringify({ clients: [...this.clients.values()], grants: [...this.grants.values()] }, null, 1))
      await rename(tmp, this.file)
    }).catch((e) => console.error('[peerpad-mcp] could not save oauth data:', e.message))
    return this.saving
  }
  private sweep() {
    const now = Date.now()
    for (const [c, p] of this.codes) if (p.expires < now) this.codes.delete(c)
    let changed = false
    for (const [id, g] of this.grants) {
      const pendingTooLong = !g.accessHash && now - g.createdAt > PENDING_TTL
      if (pendingTooLong || (g.refreshHash && g.refreshExp < now) || g.entries.every((e) => e.revoked)) { this.grants.delete(id); changed = true }
    }
    if (changed) this.save()
  }

  /* ---------- 1. dynamic client registration (RFC 7591) ---------- */
  async register(body: any) {
    const uris: unknown = body?.redirect_uris
    if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === 'string' && validRedirect(u))) {
      throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be https addresses, or http addresses on localhost.')
    }
    if (this.clients.size > 5000) throw new OAuthError('invalid_client_metadata', 'Too many registered apps on this server.', 429)
    const c: Client = { client_id: 'ppc_' + b64u(randomBytes(12)), client_name: String(body.client_name || 'AI app').slice(0, 80), redirect_uris: uris as string[], created: Date.now() }
    this.clients.set(c.client_id, c)
    await this.save()
    return {
      client_id: c.client_id, client_id_issued_at: Math.floor(c.created / 1000), client_name: c.client_name, redirect_uris: c.redirect_uris,
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    }
  }
  /** For the approval page: which app is asking, and where it will send the person back. */
  client(clientId: string, redirectUri: string) {
    const c = this.clients.get(clientId)
    if (!c) throw new OAuthError('invalid_client', 'This app is not registered with this server. Try connecting again from the app.')
    if (!redirectMatches(c.redirect_uris, redirectUri)) throw new OAuthError('invalid_request', 'The return address does not match what the app registered.')
    return { client_name: c.client_name, agent: agentKindOf(c.client_name), redirect_host: new URL(redirectUri).host }
  }

  /* ---------- 2. approval: the browser sends the chosen workspaces ---------- */
  async approve(p: { clientId: string; redirectUri: string; challenge: string; method: string; resource: string | null; workspaces: { invite: Invite; access: AgentAccess; label: string; pk: string | null }[] }) {
    const info = this.client(p.clientId, p.redirectUri)
    if (p.method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(p.challenge)) throw new OAuthError('invalid_request', 'PKCE (S256) is required.')
    if (!p.workspaces.length) throw new OAuthError('invalid_request', 'Choose at least one workspace.')
    const revoke = secret()
    const g: Grant = {
      id: 'g' + b64u(randomBytes(9)), clientId: p.clientId, clientName: info.client_name, agent: info.agent, createdAt: Date.now(), lastUsedAt: null,
      revokeHash: hash(revoke), accessHash: null, accessExp: 0, refreshHash: null, refreshExp: 0,
      entries: p.workspaces.map((w) => ({ id: b64u(randomBytes(6)), pk: w.pk, access: w.access, label: w.label.slice(0, 80), blobA: '', blobR: '' })),
    }
    this.grants.set(g.id, g)
    await this.save()
    const code = b64u(randomBytes(32))
    this.codes.set(code, {
      grantId: g.id, clientId: p.clientId, redirectUri: p.redirectUri, challenge: p.challenge, resource: p.resource, expires: Date.now() + CODE_TTL,
      invites: p.workspaces.map((w, i) => ({ entryId: g.entries[i].id, invite: w.access === 'view' ? { ...w.invite, sk: null } : w.invite, access: w.access, label: w.label })),
    })
    return { code, grantId: g.id, revoke: `og.${g.id}.${revoke}`, entries: g.entries.map((e) => ({ id: `${g.id}:${e.id}`, label: e.label, access: e.access })) }
  }

  /* ---------- 3. tokens ---------- */
  private issue(g: Grant, invites: Map<string, Invite>) {
    const a = secret(), r = secret()
    for (const e of g.entries) {
      const inv = invites.get(e.id)
      if (!inv || e.revoked) { e.blobA = ''; e.blobR = ''; continue }
      e.blobA = seal(a, inv)
      e.blobR = seal(r, inv)
    }
    g.accessHash = hash(a); g.accessExp = Date.now() + ACCESS_TTL
    g.refreshHash = hash(r); g.refreshExp = Date.now() + REFRESH_TTL
    this.save()
    return { access_token: `ppa.${g.id}.${a}`, token_type: 'Bearer', expires_in: ACCESS_TTL / 1000, refresh_token: `ppr.${g.id}.${r}`, scope: 'peerpad' }
  }
  async token(body: any) {
    const type = body?.grant_type
    if (type === 'authorization_code') {
      const p = this.codes.get(String(body.code || ''))
      this.codes.delete(String(body.code || '')) // single use
      if (!p || p.expires < Date.now()) throw new OAuthError('invalid_grant', 'The sign-in code is invalid or expired. Connect again.')
      if (body.client_id && body.client_id !== p.clientId) throw new OAuthError('invalid_grant', 'The code was issued to another app.')
      if (body.redirect_uri && body.redirect_uri !== p.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match.')
      const verifier = String(body.code_verifier || '')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      if (!verifier || !same(challenge, p.challenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed.')
      const g = this.grants.get(p.grantId)
      if (!g) throw new OAuthError('invalid_grant', 'This approval was withdrawn.')
      return this.issue(g, new Map(p.invites.map((x) => [x.entryId, x.invite])))
    }
    if (type === 'refresh_token') {
      const [kind, gid, sec] = String(body.refresh_token || '').split('.')
      const g = kind === 'ppr' ? this.grants.get(gid) : undefined
      if (!g || !g.refreshHash || !sec || !same(hash(sec), g.refreshHash) || g.refreshExp < Date.now()) throw new OAuthError('invalid_grant', 'The refresh token is invalid or expired. Connect again.')
      if (body.client_id && body.client_id !== g.clientId) throw new OAuthError('invalid_grant', 'The token was issued to another app.')
      const invites = new Map<string, Invite>()
      for (const e of g.entries) if (!e.revoked && e.blobR) invites.set(e.id, open(sec, e.blobR))
      return this.issue(g, invites) // rotates both tokens
    }
    throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.')
  }

  /** Check an access token; returns the grant id and its workspaces (decrypted), or null. */
  unlock(token: string): { grantId: string; clientName: string; workspaces: { entryId: string; label: string; access: AgentAccess; invite: Invite }[] } | null {
    const [kind, gid, sec] = String(token || '').split('.')
    const g = kind === 'ppa' ? this.grants.get(gid) : undefined
    if (!g || !g.accessHash || !sec || !same(hash(sec), g.accessHash) || g.accessExp < Date.now()) return null
    try {
      const workspaces = g.entries.filter((e) => !e.revoked && e.blobA).map((e) => ({ entryId: e.id, label: e.label, access: e.access, invite: open(sec, e.blobA) }))
      if (!workspaces.length) return null
      if (!g.lastUsedAt || Date.now() - g.lastUsedAt > 60_000) { g.lastUsedAt = Date.now(); this.save() }
      return { grantId: g.id, clientName: g.clientName, workspaces }
    } catch { return null }
  }

  /* ---------- listing and revoking (AI agents dialog) ---------- */
  listByPk(pk: string): AgentConnection[] {
    const out: AgentConnection[] = []
    for (const g of this.grants.values()) {
      if (!g.accessHash) continue
      for (const e of g.entries) if (!e.revoked && e.pk === pk) out.push({ id: `${g.id}:${e.id}`, name: g.clientName, agent: g.agent, access: e.access, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt })
    }
    return out
  }
  /** id is "grant:entry"; editors of that workspace may revoke it */
  pkOf(id: string): string | null {
    const [gid, eid] = id.split(':')
    return this.grants.get(gid)?.entries.find((e) => e.id === eid)?.pk ?? null
  }
  async revokeEntry(id: string) {
    const [gid, eid] = id.split(':')
    const g = this.grants.get(gid)
    const e = g?.entries.find((x) => x.id === eid)
    if (!g || !e) return false
    e.revoked = true; e.blobA = ''; e.blobR = ''
    if (g.entries.every((x) => x.revoked)) this.grants.delete(gid)
    await this.save()
    return true
  }
  /** the person who approved it (holds the revoke token) withdraws the whole approval */
  async revokeByToken(token: string): Promise<string | null> {
    const [kind, gid, sec] = String(token || '').split('.')
    const g = kind === 'og' ? this.grants.get(gid) : undefined
    if (!g || !sec || !same(hash(sec), g.revokeHash)) return null
    this.grants.delete(gid)
    await this.save()
    return gid
  }
}
