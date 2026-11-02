'use client'
// Approval page for AI apps (OAuth authorization endpoint). The AI app opens it in the person's browser;
// they choose workspaces and access, and the app is sent back with a one-time code.
// Workspace keys never leave this browser except as the encrypted-at-rest links the server keeps for the app.
import { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import { Sparkles, Terminal, Bot, Pencil, Eye, ShieldCheck, Check, Link2, ArrowRight } from 'lucide-react'
import { store, hashFor, type Recent } from '@/lib/session.ts'
import { useTheme } from '@/lib/hooks.ts'
import { Button, Field, cn } from './ui'

type ClientInfo = { client_name: string; agent: 'claude' | 'codex' | 'other'; redirect_host: string }
type Choice = { key: string; label: string; recent: Recent; canEdit: boolean; on: boolean; access: 'edit' | 'view' }

const sameOrigin = (u?: string | null) => { try { return !!u && u !== 'none' && new URL(u).origin === location.origin } catch { return false } }

export default function Authorize() {
  useTheme()
  const q = useMemo(() => new URLSearchParams(location.search), [])
  const clientId = q.get('client_id') || ''
  const redirectUri = q.get('redirect_uri') || ''
  const state = q.get('state')
  const [info, setInfo] = useState<ClientInfo | null>(null)
  const [fatal, setFatal] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [paste, setPaste] = useState('')
  const [choices, setChoices] = useState<Choice[]>(() => {
    const recent = store.get<Recent[]>('pp-recent', []).filter((w) => sameOrigin(w.srv))
    return recent.map((w, i) => ({ key: w.ws, label: w.name || 'Workspace', recent: w, canEdit: !!(w.pk && w.sk), on: i === 0, access: w.pk && w.sk ? 'edit' : 'view' }))
  })

  useEffect(() => {
    if (q.get('response_type') !== 'code' || !clientId || !redirectUri || !q.get('code_challenge') || q.get('code_challenge_method') !== 'S256') {
      setFatal('This sign-in link is incomplete. Start connecting again from your AI app.')
      return
    }
    fetch(`/mcp/oauth/client?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}`)
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error_description || 'Unknown app.'); setInfo(j) })
      .catch((e) => setFatal(e.message || 'The AI agents service is not reachable on this server.'))
  }, [q, clientId, redirectUri])

  const back = (params: Record<string, string>) => {
    const u = new URL(redirectUri)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    if (state) u.searchParams.set('state', state)
    location.assign(u.toString())
  }
  const addPasted = () => {
    const raw = paste.trim()
    const p = new URLSearchParams(raw.includes('#') ? raw.split('#')[1] : raw)
    if (!p.get('ws') || !p.get('key')) { setError('That is not a PeerPad invite link.'); return }
    const r: Recent = { ws: p.get('ws')!, key: p.get('key')!, pk: p.get('pk'), sk: p.get('sk'), name: 'Workspace from link', srv: location.origin }
    setChoices((c) => [...c.filter((x) => x.key !== r.ws), { key: r.ws, label: r.name!, recent: r, canEdit: !!(r.pk && r.sk), on: true, access: r.pk && r.sk ? 'edit' : 'view' }])
    setPaste(''); setError('')
  }
  const allow = async () => {
    const picked = choices.filter((c) => c.on)
    if (!picked.length) { setError('Choose at least one workspace.'); return }
    setBusy(true); setError('')
    try {
      const workspaces = picked.map((c) => ({
        label: c.label, access: c.access,
        invite: `${location.origin}/#` + hashFor({ ws: c.recent.ws, key: c.recent.key, pk: c.recent.pk, sk: c.access === 'edit' ? c.recent.sk : null }),
      }))
      const r = await fetch('/mcp/oauth/approve', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, redirect_uri: redirectUri, code_challenge: q.get('code_challenge'), code_challenge_method: 'S256', resource: q.get('resource'), workspaces }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error_description || 'Could not approve.')
      // remember it in each workspace's AI agents list, so it can be disconnected from there
      picked.forEach((c, i) => {
        const k = 'pp-agents:' + c.recent.ws
        const list = store.get<any[]>(k, [])
        store.set(k, [{ id: j.entries[i].id, token: j.revoke, address: '', name: info!.client_name, agent: info!.agent, access: c.access, createdAt: Date.now(), lastUsedAt: null }, ...list])
      })
      setDone(true)
      back({ code: j.code })
    } catch (e) { setError((e as Error).message); setBusy(false) }
  }

  const Icon = info?.agent === 'codex' ? Terminal : info?.agent === 'claude' ? Sparkles : Bot
  return (
    <div className="grid min-h-dvh place-items-center bg-bg px-4 py-10">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-pop">
        <div className="mb-5 flex items-center justify-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-accent text-lg font-bold text-accent-fg">P</span>
          <span className="flex gap-1 text-faint">{[0, 1, 2].map((i) => <motion.span key={i} className="size-1.5 rounded-full bg-current" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 1.2, delay: i * 0.2 }} />)}</span>
          <span className="grid size-11 place-items-center rounded-xl bg-hover text-fg"><Icon size={20} /></span>
        </div>

        {fatal ? (
          <div className="text-center"><h1 className="text-lg font-semibold">Can't connect</h1><p className="mt-2 text-sm text-muted">{fatal}</p></div>
        ) : !info ? (
          <div className="h-40 animate-pulse rounded-xl bg-hover" />
        ) : done ? (
          <div className="flex flex-col items-center gap-2 text-center">
            <span className="grid size-10 place-items-center rounded-full bg-accent-soft text-accent"><Check size={20} /></span>
            <h1 className="text-lg font-semibold">{info.client_name} is connected</h1>
            <p className="text-sm text-muted">Returning to {info.redirect_host}. You can close this window if it stays open.</p>
          </div>
        ) : (
          <>
            <h1 className="text-center text-lg font-semibold tracking-tight">{info.client_name} wants to use your PeerPad</h1>
            <p className="mt-1 text-center text-sm text-muted">It will be able to read, search{choices.some((c) => c.on && c.access === 'edit') ? ' and edit' : ''} pages in the workspaces you choose.</p>

            <div className="mt-5 flex flex-col gap-2">
              {choices.length === 0 && (
                <p className="rounded-xl border border-dashed border-line p-4 text-center text-sm text-muted">No workspaces from this server are open in this browser. Paste an invite link below, or open your workspace here first.</p>
              )}
              {choices.map((c) => (
                <div key={c.key} className={cn('flex items-center gap-3 rounded-xl border p-3 transition', c.on ? 'border-accent bg-accent-soft/40' : 'border-line')}>
                  <button role="checkbox" aria-checked={c.on} aria-label={`Allow ${c.label}`} onClick={() => setChoices((all) => all.map((x) => (x.key === c.key ? { ...x, on: !x.on } : x)))}
                    className={cn('grid size-5 shrink-0 place-items-center rounded-md border transition', c.on ? 'border-accent bg-accent text-accent-fg' : 'border-faint')}>
                    {c.on && <Check size={13} />}
                  </button>
                  <span className="min-w-0 flex-1 truncate font-medium">{c.label}</span>
                  <div className="flex rounded-lg bg-hover p-0.5 text-xs" role="radiogroup" aria-label={`Access to ${c.label}`}>
                    {(['edit', 'view'] as const).map((a) => (
                      <button key={a} role="radio" aria-checked={c.access === a} disabled={a === 'edit' && !c.canEdit}
                        onClick={() => setChoices((all) => all.map((x) => (x.key === c.key ? { ...x, access: a, on: true } : x)))}
                        className={cn('flex items-center gap-1 rounded-md px-2 py-1 transition disabled:opacity-40', c.access === a ? 'bg-surface text-fg shadow-sm' : 'text-muted')}>
                        {a === 'edit' ? <Pencil size={11} /> : <Eye size={11} />}{a === 'edit' ? 'Edit' : 'View'}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <div className="flex gap-2 pt-1">
                <Field value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Or paste an invite link" aria-label="Invite link" onKeyDown={(e) => e.key === 'Enter' && addPasted()} />
                <Button onClick={addPasted} disabled={!paste.trim()} aria-label="Add workspace from link"><Link2 size={14} /></Button>
              </div>
            </div>

            {error && <p className="mt-3 text-sm text-danger">{error}</p>}
            <div className="mt-6 flex gap-2">
              <Button className="flex-1" onClick={() => back({ error: 'access_denied', error_description: 'The request was declined.' })}>Cancel</Button>
              <Button variant="primary" className="flex-1" disabled={busy || !choices.some((c) => c.on)} onClick={allow}>{busy ? 'Connecting…' : <>Allow <ArrowRight size={14} /></>}</Button>
            </div>
            <p className="mt-4 flex items-start gap-2 text-xs text-muted">
              <ShieldCheck size={14} className="mt-0.5 shrink-0 text-accent" />
              <span>You'll return to <span className="font-medium text-fg">{info.redirect_host}</span>. You can disconnect it any time in PeerPad (AI agents). While it works, the server decrypts the chosen workspaces for it.</span>
            </p>
          </>
        )}
      </motion.div>
    </div>
  )
}
