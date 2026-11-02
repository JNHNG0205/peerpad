'use client'
import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Sparkles, Terminal, Pencil, Eye, Copy, Trash2, ShieldCheck, ArrowLeft, Plus, Bot } from 'lucide-react'
import { useWorkspace } from './workspace'
import { Button, Field, Modal, copyText, useToast, cn } from './ui'
import { inviteLink, store } from '@/lib/session.ts'
import { loadSigner, b64u } from '@/lib/remote.ts'
import { proofMessage, type AgentConnection, type AgentKind, type AgentAccess } from '@/lib/agents.ts'

type Mine = AgentConnection & { token: string; address: string }
const AGENTS: { id: AgentKind; label: string; blurb: string; icon: React.ReactNode }[] = [
  { id: 'claude', label: 'Claude', blurb: 'claude.ai, desktop, mobile, Claude Code', icon: <Sparkles size={18} /> },
  { id: 'codex', label: 'Codex', blurb: 'Codex CLI and IDE extension', icon: <Terminal size={18} /> },
]
const agentLabel = (a: AgentKind) => (a === 'claude' ? 'Claude' : a === 'codex' ? 'Codex' : 'AI')
const when = (t: number | null) => (t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'never')

export function AgentsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWorkspace()
  const { s } = w
  const toast = useToast()
  const base = s.serverUrl?.replace(/\/+$/, '') || ''
  const mineKey = 'pp-agents:' + s.ws
  const [status, setStatus] = useState<'checking' | 'enabled' | 'disabled' | 'no-server'>('checking')
  const [view, setView] = useState<'list' | 'create' | 'created'>('list')
  const [agent, setAgent] = useState<AgentKind>('claude')
  const [access, setAccess] = useState<AgentAccess>(w.readOnly ? 'view' : 'edit')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [mine, setMine] = useState<Mine[]>(() => store.get<Mine[]>(mineKey, []))
  const [all, setAll] = useState<AgentConnection[] | null>(null)
  const [created, setCreated] = useState<Mine | null>(null)
  const canManageAll = !!s.pk && !w.readOnly

  const saveMine = (list: Mine[]) => { setMine(list); store.set(mineKey, list) }
  const proof = useCallback(async (action: 'list' | 'revoke', id = '') => {
    const signer = await loadSigner(s.pk, s.sk)
    if (!signer?.canWrite || !s.pk) throw new Error('Only editors can do this.')
    const ts = Date.now()
    return { pk: s.pk, ts, sig: b64u(await signer.sign(proofMessage(action, s.pk, ts, id))) }
  }, [s])
  const api = useCallback(async (path: string, body?: unknown) => {
    const r = await fetch(base + '/mcp/agents' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
    const json = await r.json().catch(() => null)
    if (!json) throw new Error('The AI agents service is not reachable on this server (requests to /mcp do not reach it).')
    if (!r.ok) throw new Error(json.error || `Request failed (${r.status})`)
    return json
  }, [base])
  const refreshAll = useCallback(async () => {
    if (!canManageAll) return
    try { setAll((await api('/list', await proof('list'))).connections) } catch { setAll(null) }
  }, [api, proof, canManageAll])

  useEffect(() => {
    if (!open) return
    setView('list'); setError(''); setCreated(null)
    if (!base) { setStatus('no-server'); return }
    setStatus('checking')
    api('/status').then((j) => { if (j?.enabled !== true) throw new Error(); setStatus('enabled'); refreshAll() }).catch(() => setStatus('disabled'))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setName(`${w.me.name.split(' ')[0]}'s ${agentLabel(agent)}`) }, [agent, w.me.name])

  const create = async () => {
    setBusy(true); setError('')
    try {
      const res = await api('', { invite: inviteLink(s, access === 'edit'), name, agent, access })
      const m: Mine = { ...res, token: res.token, address: res.address }
      saveMine([m, ...mine])
      setCreated(m); setView('created')
      refreshAll()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const revoke = async (c: AgentConnection) => {
    const own = mine.find((m) => m.id === c.id)
    try {
      await api('/revoke', own ? { token: own.token } : { id: c.id, ...(await proof('revoke', c.id)) })
      saveMine(mine.filter((m) => m.id !== c.id))
      setAll((a) => a?.filter((x) => x.id !== c.id) ?? null)
      toast(`${c.name} disconnected`)
    } catch (e) { toast((e as Error).message) }
  }

  const rows: (AgentConnection & { own: boolean })[] = canManageAll && all
    ? all.map((c) => ({ ...c, own: mine.some((m) => m.id === c.id) }))
    : mine.map((c) => ({ ...c, own: true }))

  return (
    <Modal open={open} onClose={onClose} title="AI agents" width="max-w-xl">
      {status === 'no-server' && <Notice>AI agents need a PeerPad server. Open this workspace from your server's address, or set one in workspace menu → Server.</Notice>}
      {status === 'disabled' && (
        <Notice>
          AI agents aren't reachable on this server. Whoever runs it should check that the AI service is running and that requests to <code className="rounded bg-hover px-1 font-mono text-xs">/mcp</code> reach it. With the Docker setup, run{' '}
          <code className="rounded bg-hover px-1 font-mono text-xs">docker compose up -d --force-recreate caddy</code> after updating.
        </Notice>
      )}
      {status === 'checking' && <div className="h-24 animate-pulse rounded-xl bg-hover" />}
      {status === 'enabled' && (
        <AnimatePresence mode="wait" initial={false}>
          {view === 'list' && (
            <motion.div key="list" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }} className="flex flex-col gap-3">
              <p className="text-muted">Let Claude or Codex read and edit this workspace. Add PeerPad once in your AI app; it opens PeerPad in your browser so you can approve it.</p>
              <OneStep address={`${base}/mcp`} />
              <div className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-faint">Connected</div>
              {rows.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line py-8 text-center">
                  <Bot size={22} className="text-faint" />
                  <p className="text-sm text-muted">No AI agents connected yet.</p>
                </div>
              ) : (
                <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
                  {rows.map((c) => (
                    <li key={c.id} className="flex items-center gap-3 px-3 py-2.5">
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-hover text-muted">{c.agent === 'codex' ? <Terminal size={15} /> : c.agent === 'claude' ? <Sparkles size={15} /> : <Bot size={15} />}</span>
                      <div className="min-w-0 flex-1 leading-tight">
                        <div className="truncate font-medium">{c.name}{c.own && <span className="ml-1.5 text-xs font-normal text-faint">yours</span>}</div>
                        <div className="text-xs text-muted">{c.access === 'edit' ? 'Can edit' : 'Can view'} · added {when(c.createdAt)} · last used {when(c.lastUsedAt)}</div>
                      </div>
                      {c.own && mine.find((m) => m.id === c.id)?.address && (
                        <Button size="icon" variant="ghost" title="Copy address" aria-label="Copy address" onClick={() => copyText(mine.find((m) => m.id === c.id)!.address, toast)}><Copy size={15} /></Button>
                      )}
                      {(c.own || canManageAll) && (
                        <Button size="icon" variant="ghost" title="Disconnect" aria-label={`Disconnect ${c.name}`} className="hover:text-danger" onClick={() => revoke(c)}><Trash2 size={15} /></Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <button onClick={() => setView('create')} className="flex w-fit items-center gap-1 self-end text-xs text-muted underline decoration-line underline-offset-4 hover:text-fg">
                <Plus size={12} /> App without sign-in support? Create a personal address
              </button>
            </motion.div>
          )}

          {view === 'create' && (
            <motion.div key="create" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} className="flex flex-col gap-4">
              {(mine.length > 0 || canManageAll) && (
                <button onClick={() => setView('list')} className="-mt-1 flex w-fit items-center gap-1 text-xs text-muted hover:text-fg"><ArrowLeft size={13} /> Back</button>
              )}
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="AI agent">
                {AGENTS.map((a) => (
                  <button key={a.id} role="radio" aria-checked={agent === a.id} onClick={() => setAgent(a.id)}
                    className={cn('relative flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition', agent === a.id ? 'border-accent bg-accent-soft/50' : 'border-line hover:border-faint')}>
                    <span className={cn('grid size-8 place-items-center rounded-lg', agent === a.id ? 'bg-accent text-accent-fg' : 'bg-hover text-muted')}>{a.icon}</span>
                    <span className="font-medium">{a.label}</span>
                    <span className="text-xs text-muted">{a.blurb}</span>
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Access">
                {(['edit', 'view'] as const).map((a) => (
                  <button key={a} role="radio" aria-checked={access === a} disabled={a === 'edit' && w.readOnly} onClick={() => setAccess(a)}
                    className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition disabled:opacity-40', access === a ? 'border-accent bg-accent-soft/50' : 'border-line hover:border-faint')}>
                    {a === 'edit' ? <Pencil size={14} /> : <Eye size={14} />}
                    <span><span className="font-medium">{a === 'edit' ? 'Can edit' : 'Can view'}</span><span className="block text-xs text-muted">{a === 'edit' ? 'Read and change pages' : 'Read pages only'}</span></span>
                  </button>
                ))}
              </div>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted">Name shown to teammates</span>
                <Field value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
              </label>
              {error && <p className="text-xs text-danger">{error}</p>}
              <p className="flex items-start gap-2 text-xs text-muted">
                <ShieldCheck size={14} className="mt-0.5 shrink-0 text-accent" />
                While this agent is working, your PeerPad server decrypts this workspace for it. When it is idle, the server cannot read it.
              </p>
              <div className="flex justify-end gap-2">
                <Button onClick={onClose}>Cancel</Button>
                <Button variant="primary" disabled={busy || !name.trim()} onClick={create}>{busy ? 'Connecting…' : `Connect ${agentLabel(agent)}`}</Button>
              </div>
            </motion.div>
          )}

          {view === 'created' && created && (
            <motion.div key="created" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex flex-col gap-4">
              <div className="flex items-center gap-3 rounded-xl bg-accent-soft/60 p-3">
                <span className="grid size-9 place-items-center rounded-lg bg-accent text-accent-fg">{created.agent === 'codex' ? <Terminal size={17} /> : <Sparkles size={17} />}</span>
                <div className="leading-tight"><div className="font-medium">{created.name} is ready</div><div className="text-xs text-muted">{created.access === 'edit' ? 'Can edit' : 'Can view'} · copy the address below into {agentLabel(created.agent)}</div></div>
              </div>
              <div className="flex gap-2">
                <Field readOnly value={created.address} onFocus={(e) => e.currentTarget.select()} aria-label="Connection address" className="font-mono text-xs" />
                <Button variant="primary" onClick={() => copyText(created.address, toast)}><Copy size={14} /> Copy</Button>
              </div>
              <p className="text-xs text-muted">Treat this address like a password: anyone who has it can use this connection. You can disconnect it at any time.</p>
              <Setup agent={created.agent} address={created.address} />
              <div className="flex justify-end gap-2">
                <Button onClick={() => setView('list')}>See all agents</Button>
                <Button variant="primary" onClick={onClose}>Done</Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </Modal>
  )
}

/** The recommended setup: one address, and the AI app handles sign-in (OAuth) by opening PeerPad's approval page. */
function OneStep({ address }: { address: string }) {
  const toast = useToast()
  const [tab, setTab] = useState(0)
  const tabs: { label: string; steps: string[]; code?: string }[] = [
    { label: 'Claude', steps: ['In Claude, open Settings → Connectors → Add custom connector.', 'Name it PeerPad and paste the address above, then click Add.', 'Click Connect: PeerPad opens so you can choose workspaces and approve.'] },
    { label: 'Claude Code', steps: ['Run this, then type /mcp in Claude Code and choose PeerPad → Authenticate:'], code: `claude mcp add --transport http peerpad ${address}` },
    { label: 'Codex', steps: ['Run these in a terminal; the second opens PeerPad to approve:'], code: `codex mcp add peerpad --url ${address}\ncodex mcp login peerpad` },
    { label: 'ChatGPT', steps: ['In ChatGPT settings, turn on Developer mode (under Apps & Connectors → Advanced; needs a plan that allows it).', 'Create a connector: name PeerPad, paste the address above, Authentication: OAuth, then Create.', 'ChatGPT opens PeerPad: choose workspaces and approve. Then enable PeerPad in a chat under Developer mode.'] },
  ]
  const t = tabs[tab]
  return (
    <div className="rounded-xl border border-line">
      <div className="flex gap-2 border-b border-line p-3">
        <Field readOnly value={address} onFocus={(e) => e.currentTarget.select()} aria-label="PeerPad address for AI apps" className="font-mono text-xs" />
        <Button variant="primary" onClick={() => copyText(address, toast)}><Copy size={14} /> Copy</Button>
      </div>
      <div className="flex gap-1 border-b border-line p-1">
        {tabs.map((x, i) => (
          <button key={x.label} onClick={() => setTab(i)} className={cn('relative rounded-md px-3 py-1.5 text-xs font-medium transition', tab === i ? 'text-fg' : 'text-muted hover:text-fg')}>
            {tab === i && <motion.span layoutId="onestep-tab" className="absolute inset-0 rounded-md bg-hover" />}
            <span className="relative">{x.label}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2 p-3 text-sm">
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-muted">{t.steps.map((st) => <li key={st}>{st}</li>)}</ol>
        {t.code && (
          <div className="relative">
            <pre className="overflow-x-auto rounded-lg bg-fg p-3 pr-10 font-mono text-[12px] leading-relaxed text-bg">{t.code}</pre>
            <button onClick={() => copyText(t.code!, toast)} aria-label="Copy command" className="absolute right-2 top-2 rounded-md p-1.5 text-bg/60 transition hover:bg-bg/10 hover:text-bg"><Copy size={13} /></button>
          </div>
        )}
      </div>
    </div>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-line bg-hover/50 p-4 text-sm text-muted">{children}</div>
}

function Setup({ agent, address }: { agent: AgentKind; address: string }) {
  const toast = useToast()
  const [tab, setTab] = useState(0)
  const tabs = agent === 'codex'
    ? [
        { label: 'Codex CLI', steps: ['Run this in a terminal:'], code: `codex mcp add peerpad --url "${address}"` },
        { label: 'config.toml', steps: ['Or add this to ~/.codex/config.toml:'], code: `[mcp_servers.peerpad]\nurl = "${address}"` },
      ]
    : [
        { label: 'Claude app', steps: ['Open Claude → Settings → Connectors.', 'Click Add custom connector, name it PeerPad, paste the address, then Add.', 'In a chat, turn PeerPad on in the tools menu.'] },
        { label: 'Claude Code', steps: ['Run this in a terminal:'], code: `claude mcp add --transport http peerpad "${address}"` },
      ]
  const t = tabs[tab]
  return (
    <div className="rounded-xl border border-line">
      <div className="flex gap-1 border-b border-line p-1">
        {tabs.map((x, i) => (
          <button key={x.label} onClick={() => setTab(i)} className={cn('relative rounded-md px-3 py-1.5 text-xs font-medium transition', tab === i ? 'text-fg' : 'text-muted hover:text-fg')}>
            {tab === i && <motion.span layoutId="setup-tab" className="absolute inset-0 rounded-md bg-hover" />}
            <span className="relative">{x.label}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2 p-3 text-sm">
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-muted">{t.steps.map((st) => <li key={st}>{st}</li>)}</ol>
        {t.code && (
          <div className="group relative">
            <pre className="overflow-x-auto rounded-lg bg-fg p-3 pr-10 font-mono text-[12px] leading-relaxed text-bg">{t.code}</pre>
            <button onClick={() => copyText(t.code!, toast)} aria-label="Copy command" className="absolute right-2 top-2 rounded-md p-1.5 text-bg/60 transition hover:bg-bg/10 hover:text-bg"><Copy size={13} /></button>
          </div>
        )}
      </div>
    </div>
  )
}
