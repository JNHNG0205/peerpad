'use client'
import { useState } from 'react'
import { Pencil, Eye, ShieldCheck, Copy } from 'lucide-react'
import { useWorkspace, type DialogName, type Confirm } from './workspace'
import { Button, Field, Modal, copyText, useToast, cn } from './ui'
import { inviteLink, rememberWorkspace, store, hashFor, COLORS, generateWriteKeys, type Recent } from '@/lib/session.ts'

export function Dialogs({ open, close, confirm, closeConfirm }: { open: DialogName | null; close: () => void; confirm: Confirm | null; closeConfirm: () => void }) {
  return (
    <>
      <ShareDialog open={open === 'share'} onClose={close} />
      <ServerDialog open={open === 'server'} onClose={close} />
      <ProfileDialog open={open === 'profile'} onClose={close} />
      <JoinDialog open={open === 'join'} onClose={close} />
      <RenameDialog open={open === 'rename'} onClose={close} />
      <Modal open={!!confirm} onClose={closeConfirm} title={confirm?.title || ''} width="max-w-md"
        footer={<>
          <Button onClick={closeConfirm}>Cancel</Button>
          <Button variant="danger" onClick={() => { confirm?.onConfirm(); closeConfirm() }}>{confirm?.action}</Button>
        </>}>
        <p className="text-muted">{confirm?.text}</p>
      </Modal>
    </>
  )
}

function LinkRow({ edit }: { edit: boolean }) {
  const { s } = useWorkspace()
  const toast = useToast()
  const link = inviteLink(s, edit)
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <div className="flex items-center gap-2">
        <span className={cn('grid size-7 place-items-center rounded-lg', edit ? 'bg-accent-soft text-accent' : 'bg-hover text-muted')}>{edit ? <Pencil size={14} /> : <Eye size={14} />}</span>
        <div className="leading-tight">
          <div className="font-medium">{edit ? 'Can edit' : 'Can view'}</div>
          <div className="text-xs text-muted">{edit ? 'Write, rename and delete pages' : 'Read every page and see changes live'}</div>
        </div>
      </div>
      <div className="flex gap-2">
        <Field readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label={edit ? 'Edit link' : 'View link'} className="font-mono text-xs" />
        <Button variant={edit ? 'primary' : 'outline'} onClick={() => copyText(link, toast)}><Copy size={14} /> Copy</Button>
      </div>
    </div>
  )
}

function ShareDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWorkspace()
  const { s } = w
  const [busy, setBusy] = useState(false)
  return (
    <Modal open={open} onClose={onClose} title="Share this workspace" footer={<Button onClick={onClose}>Done</Button>}>
      {w.readOnly ? (
        <>
          <p className="text-muted">You have view access, so you can share a view-only link.</p>
          <LinkRow edit={false} />
        </>
      ) : s.pk ? (
        <>
          <LinkRow edit />
          <LinkRow edit={false} />
        </>
      ) : (
        <>
          <LinkRow edit />
          <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-line p-3">
            <p><span className="font-medium">Want view-only links?</span>{' '}
              <span className="text-muted">{s.serverUrl
                ? 'Turn on permissions for this workspace. Links shared before now become view-only, so send editors the new edit link afterwards.'
                : 'This needs a sync server (workspace menu → Sync server), so the server can block changes from view-only links.'}</span>
            </p>
            {s.serverUrl && (
              <Button disabled={busy} onClick={async () => {
                setBusy(true)
                const keys = await generateWriteKeys()
                s.pk = keys.pk; s.sk = keys.sk
                rememberWorkspace(s, (s.meta.get('name') as string) || 'Shared workspace')
                location.hash = hashFor({ ws: s.ws, key: s.key, srv: s.servedByServer ? null : s.serverUrl, ...keys }, w.pageId)
                location.reload()
              }}>Turn on view-only links</Button>
            )}
          </div>
        </>
      )}
      <p className="flex items-start gap-2 text-xs text-muted">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-accent" />
        Links contain the workspace key, so share them privately. Pages are encrypted with it in your browser; the sync server cannot read them.
      </p>
    </Modal>
  )
}

function ServerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWorkspace()
  const { s } = w
  const [value, setValue] = useState(s.serverUrl || '')
  const [err, setErr] = useState('')
  const st = s.net.status()
  const save = () => {
    const v = value.trim().replace(/\/+$/, '')
    if (v && !/^https?:\/\/\S+$/.test(v)) { setErr('Enter a full address starting with https://'); return }
    const list = store.get<Recent[]>('pp-recent', []).filter((r) => r.ws !== s.ws)
    const entry: Recent = { ws: s.ws, key: s.key, name: (s.meta.get('name') as string) || 'Shared workspace', srv: v || 'none', pk: s.pk, sk: s.readOnly ? null : s.sk }
    store.set('pp-recent', [entry, ...list])
    location.hash = hashFor(entry, w.pageId)
    location.reload()
  }
  return (
    <Modal open={open} onClose={onClose} title="Sync server"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save and reconnect</Button></>}>
      <p className="text-muted">A sync server keeps an always-on, encrypted copy of this workspace, so edits reach teammates even when nobody else is online.</p>
      <label htmlFor="srv" className="text-xs font-medium text-muted">Server address (leave empty for peer-to-peer only)</label>
      <Field id="srv" value={value} onChange={(e) => { setValue(e.target.value); setErr('') }} placeholder="https://notes.example.com" className="font-mono text-xs" />
      {err && <p className="text-xs text-danger">{err}</p>}
      {st.server && <p className="text-xs text-muted">Status: {({ connected: 'Connected', connecting: 'Connecting…', offline: 'Unreachable, retrying', error: st.serverError || 'Error', closed: 'Closed' } as const)[st.server]}</p>}
    </Modal>
  )
}

function ProfileDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWorkspace()
  const [name, setName] = useState(w.me.name)
  const [color, setColor] = useState(w.me.color)
  return (
    <Modal open={open} onClose={onClose} title="Your name and color" width="max-w-md"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => { w.setMe({ name: name.trim() || w.me.name, color }); onClose() }}>Save</Button></>}>
      <label htmlFor="me" className="text-xs font-medium text-muted">Shown to teammates next to your cursor</label>
      <Field id="me" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="flex flex-wrap gap-2 pt-1">
        {COLORS.map((c) => (
          <button key={c} aria-label={c} onClick={() => setColor(c)} style={{ background: c }}
            className={cn('size-8 rounded-full transition-transform hover:scale-110', color === c && 'ring-2 ring-fg ring-offset-2 ring-offset-surface')} />
        ))}
      </div>
    </Modal>
  )
}

function JoinDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [value, setValue] = useState('')
  const [err, setErr] = useState('')
  const join = () => {
    const raw = value.trim()
    const hash = raw.includes('#') ? raw.split('#')[1] : raw
    const p = new URLSearchParams(hash)
    if (!p.get('ws') || !p.get('key')) { setErr('That link is missing the workspace ID or key. Ask for a fresh invite link.'); return }
    const base = raw.includes('#') ? raw.split('#')[0] : ''
    if (/^https?:/.test(base) && base !== location.href.split('#')[0]) { location.href = raw; return }
    location.hash = hash
    onClose()
  }
  return (
    <Modal open={open} onClose={onClose} title="Join a workspace" width="max-w-md"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={join}>Join</Button></>}>
      <Field autoFocus value={value} onChange={(e) => { setValue(e.target.value); setErr('') }} placeholder="Paste the invite link" onKeyDown={(e) => e.key === 'Enter' && join()} />
      {err && <p className="text-xs text-danger">{err}</p>}
    </Modal>
  )
}

function RenameDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { s } = useWorkspace()
  const [value, setValue] = useState((s.meta.get('name') as string) || '')
  const save = () => { s.doc.transact(() => s.meta.set('name', value.trim() || 'Shared workspace'), 'local'); onClose() }
  return (
    <Modal open={open} onClose={onClose} title="Rename workspace" width="max-w-md"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <Field autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
    </Modal>
  )
}
