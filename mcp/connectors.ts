// Registry of AI agent connections ("connectors").
// Each connection has an address https://<server>/mcp/c/<id>.<secret>. The workspace invite it uses
// is stored encrypted with a key derived from <secret>, and only a hash of <secret> is kept, so the
// file on disk is useless without the addresses themselves.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { createHash, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto'
import path from 'node:path'
import type { AgentAccess, AgentKind, AgentConnection } from '../lib/agents.ts'

export type Invite = { ws: string; key: string; server: string; pk: string | null; sk: string | null }
type Record = AgentConnection & {
  secretHash: string // sha256 of the secret, hex
  blob: string       // AES-256-GCM(invite JSON), key = sha256('peerpad-connector-key:' + secret)
  pk: string | null  // workspace public key (public information) so editors can list/revoke
}

const b64u = (b: Buffer) => b.toString('base64url')
const sha256 = (s: string) => createHash('sha256').update(s).digest()
const keyFor = (secret: string) => sha256('peerpad-connector-key:' + secret)

function seal(secret: string, invite: Invite): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', keyFor(secret), iv)
  const ct = Buffer.concat([c.update(JSON.stringify(invite), 'utf8'), c.final()])
  return b64u(Buffer.concat([iv, c.getAuthTag(), ct]))
}
function open(secret: string, blob: string): Invite {
  const buf = Buffer.from(blob, 'base64url')
  const d = createDecipheriv('aes-256-gcm', keyFor(secret), buf.subarray(0, 12))
  d.setAuthTag(buf.subarray(12, 28))
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'))
}

export class Connectors {
  private file: string
  private items = new Map<string, Record>()
  private saving: Promise<void> = Promise.resolve()
  constructor(dataDir: string) { this.file = path.join(dataDir, 'connectors.json') }

  async load() {
    await mkdir(path.dirname(this.file), { recursive: true })
    try {
      const list: Record[] = JSON.parse(await readFile(this.file, 'utf8'))
      for (const r of list) this.items.set(r.id, r)
    } catch {}
  }
  private save() {
    this.saving = this.saving.then(async () => {
      const tmp = this.file + '.tmp'
      await writeFile(tmp, JSON.stringify([...this.items.values()], null, 1))
      await rename(tmp, this.file)
    }).catch((e) => console.error('[peerpad-mcp] could not save connectors:', e.message))
    return this.saving
  }
  get size() { return this.items.size }

  async create(invite: Invite, opts: { name: string; agent: AgentKind; access: AgentAccess }): Promise<{ id: string; token: string; info: AgentConnection }> {
    const id = b64u(randomBytes(9))
    const secret = b64u(randomBytes(24))
    const stored: Invite = opts.access === 'view' ? { ...invite, sk: null } : invite
    const r: Record = {
      id, name: opts.name, agent: opts.agent, access: opts.access, createdAt: Date.now(), lastUsedAt: null,
      secretHash: sha256(secret).toString('hex'), blob: seal(secret, stored), pk: invite.pk,
    }
    this.items.set(id, r)
    await this.save()
    return { id, token: `${id}.${secret}`, info: this.info(r) }
  }
  /** Checks a connection address token; returns the decrypted invite, or null. */
  unlock(token: string): { id: string; invite: Invite; info: AgentConnection } | null {
    const [id, secret] = String(token).split('.')
    const r = id && secret ? this.items.get(id) : undefined
    if (!r) return null
    const a = Buffer.from(r.secretHash, 'hex'), b = sha256(secret)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    try {
      const invite = open(secret, r.blob)
      if (!r.lastUsedAt || Date.now() - r.lastUsedAt > 60_000) { r.lastUsedAt = Date.now(); this.save() }
      return { id, invite, info: this.info(r) }
    } catch { return null }
  }
  listByPk(pk: string): AgentConnection[] {
    return [...this.items.values()].filter((r) => r.pk === pk).map((r) => this.info(r)).sort((a, b) => b.createdAt - a.createdAt)
  }
  pkOf(id: string): string | null { return this.items.get(id)?.pk ?? null }
  has(id: string) { return this.items.has(id) }
  async remove(ids: string[]) {
    let n = 0
    for (const id of ids) if (this.items.delete(id)) n++
    if (n) await this.save()
    return n
  }
  private info(r: Record): AgentConnection {
    return { id: r.id, name: r.name, agent: r.agent, access: r.access, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt }
  }
}
