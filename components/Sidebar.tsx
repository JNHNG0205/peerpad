'use client'
import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  ChevronRight, ChevronsUpDown, Plus, Search, MoreHorizontal, Trash2, FilePlus2, PanelLeftClose, FileText,
  Sun, Moon, Monitor, Cloud, LogIn, Pencil, UserRound, Check, FileUp,
} from 'lucide-react'
import { useWorkspace } from './workspace'
import { useY, useNet } from '@/lib/hooks.ts'
import { childrenOf, titleOf, iconOf } from '@/lib/pages.ts'
import { store, hashFor, newWorkspaceHash, type Recent } from '@/lib/session.ts'
import { Avatar, MenuButton, cn, type MenuItem } from './ui'

export function Sidebar() {
  const w = useWorkspace()
  const { s } = w
  useY(s.pages, true, (evs) => evs.some((e) => e.path.length < 2 || e.path[1] !== 'blocks'))
  useY(s.meta, false)
  useNet(s.net)
  const name = (s.meta.get('name') as string) || 'Shared workspace'
  const roots = childrenOf(s.pages, null)
  const peers = s.net.peers()

  const wsItems = (): MenuItem[] => {
    const recent = store.get<Recent[]>('pp-recent', [])
    return [
      { heading: 'Workspaces' },
      ...recent.map((r) => ({ label: r.name || 'Workspace', icon: <span className="text-[11px] font-bold">{(r.name || 'W')[0]}</span>, checked: r.ws === s.ws, onSelect: () => { if (r.ws !== s.ws) location.hash = hashFor(r) } })),
      { separator: true as const },
      ...(w.readOnly ? [] : [{ label: 'Rename workspace', icon: <Pencil />, onSelect: () => w.dialog('rename') }]),
      { label: 'New workspace', icon: <Plus />, onSelect: async () => { location.hash = await newWorkspaceHash(s.serverUrl) } },
      { label: 'Join with invite link', icon: <LogIn />, onSelect: () => w.dialog('join') },
      { label: 'Sync server', icon: <Cloud />, hint: s.serverUrl ? 'On' : 'Off', onSelect: () => w.dialog('server') },
      { label: 'Your name and color', icon: <UserRound />, onSelect: () => w.dialog('profile') },
    ]
  }

  return (
    <div className="flex h-full flex-col gap-1 px-2 pb-3 pt-[max(0.625rem,env(safe-area-inset-top))]">
      <div className="flex items-center gap-1">
        <MenuButton items={wsItems} label="Switch workspace" width={260}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-hover">
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent text-xs font-bold text-accent-fg">{name.trim()[0]?.toUpperCase() || 'P'}</span>
          <span className="truncate text-sm font-semibold">{name}</span>
          <ChevronsUpDown size={14} className="ml-auto shrink-0 text-faint" />
        </MenuButton>
        <button onClick={() => w.sidebar.setOpen(false)} title="Hide sidebar (Ctrl+\)" aria-label="Hide sidebar"
          className="grid size-8 shrink-0 place-items-center rounded-lg text-faint transition hover:bg-hover hover:text-fg">
          <PanelLeftClose size={16} />
        </button>
      </div>

      <Status />

      <button onClick={() => w.palette(true)}
        className="mx-0.5 mt-1 flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left text-[13px] text-muted shadow-[0_1px_0_rgb(0_0_0/0.02)] transition hover:border-faint hover:text-fg">
        <Search size={14} /> <span className="flex-1">Search</span>
        <kbd className="rounded border border-line px-1.5 font-sans text-[10px] text-faint">Ctrl K</kbd>
      </button>

      <div className="mt-3 flex items-center justify-between px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Pages</span>
        {!w.readOnly && (
          <div className="flex">
            <button title="Import Markdown" aria-label="Import Markdown" onClick={() => w.importMarkdown(null)} className="grid size-6 place-items-center rounded-md text-faint transition hover:bg-hover hover:text-fg"><FileUp size={14} /></button>
            <button title="New page" aria-label="New page" onClick={() => w.createPage(null)} className="grid size-6 place-items-center rounded-md text-faint transition hover:bg-hover hover:text-fg"><Plus size={15} /></button>
          </div>
        )}
      </div>
      <nav className="-mx-0.5 flex min-h-0 flex-1 flex-col overflow-y-auto px-0.5">
        {roots.map((id) => <TreeItem key={id} id={id} depth={0} peers={peers} />)}
        {roots.length === 0 && <p className="px-2.5 py-2 text-[13px] text-faint">No pages yet.</p>}
        {!w.readOnly && (
          <button onClick={() => w.createPage(null)} className="mt-0.5 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] text-muted transition hover:bg-hover hover:text-fg">
            <Plus size={15} /> New page
          </button>
        )}

        <div className="mt-5 px-2 text-[11px] font-semibold uppercase tracking-wider text-faint">People here</div>
        <button onClick={() => w.dialog('profile')} className="mt-1 flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-hover">
          <Avatar name={w.me.name} color={w.me.color} ring={false} />
          <span className="truncate text-[13.5px]">{w.me.name} <span className="text-faint">{w.readOnly ? '(you, viewing)' : '(you)'}</span></span>
        </button>
        <AnimatePresence initial={false}>
          {peers.map((p) => (
            <motion.button key={p.clientId} layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }}
              onClick={() => p.page && w.openPage(p.page)}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-hover">
              <span className="relative">
                <Avatar name={p.name} color={p.color} ring={false} />
                <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-sidebar bg-[#30a46c]" />
              </span>
              <span className="min-w-0 leading-tight">
                <span className="block truncate text-[13.5px]">{p.name}</span>
                <span className="block truncate text-xs text-faint">{p.role === 'view' ? 'Viewing ' : 'On '}{p.page ? titleOf(s.pages, p.page) : 'no page'}</span>
              </span>
            </motion.button>
          ))}
        </AnimatePresence>
      </nav>

      <ThemeSwitch />
    </div>
  )
}

function TreeItem({ id, depth, peers }: { id: string; depth: number; peers: ReturnType<ReturnType<typeof useWorkspace>['s']['net']['peers']> }) {
  const w = useWorkspace()
  const { s } = w
  const [open, setOpen] = useState(() => !store.get<string[]>('pp-collapsed', []).includes(id))
  const kids = childrenOf(s.pages, id)
  const active = w.pageId === id
  const here = peers.filter((p) => p.page === id)
  const toggle = () => {
    const next = !open
    setOpen(next)
    const c = new Set(store.get<string[]>('pp-collapsed', []))
    next ? c.delete(id) : c.add(id)
    store.set('pp-collapsed', [...c])
  }
  const menu = (): MenuItem[] => [
    { label: 'Add page inside', icon: <FilePlus2 />, onSelect: () => { setOpen(true); w.createPage(id) } },
    { label: 'Import Markdown inside', icon: <FileUp />, onSelect: () => { setOpen(true); w.importMarkdown(id) } },
    { separator: true },
    { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => w.askDeletePage(id) },
  ]
  return (
    <div>
      <motion.div layout="position"
        className={cn('group relative flex h-8 items-center rounded-lg pr-1 transition-colors', active ? 'bg-active text-fg' : 'text-fg/85 hover:bg-hover')}
        style={{ paddingLeft: 4 + depth * 14 }}>
        {active && <motion.span layoutId="active-page" className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-accent" />}
        <button onClick={toggle} aria-label={open ? 'Collapse' : 'Expand'}
          className={cn('grid size-5 shrink-0 place-items-center rounded text-faint transition hover:bg-active hover:text-fg', !kids.length && 'invisible')}>
          <ChevronRight size={13} className={cn('transition-transform duration-200', open && 'rotate-90')} />
        </button>
        <button onClick={() => w.openPage(id)} className="flex min-w-0 flex-1 items-center gap-2 px-1 text-left text-[13.5px]">
          <span className="grid w-[18px] shrink-0 place-items-center text-[15px] leading-none">{iconOf(s.pages, id) || <FileText size={15} className="text-faint" />}</span>
          <span className={cn('truncate', active && 'font-medium')}>{titleOf(s.pages, id)}</span>
        </button>
        {here.length > 0 && (
          <span className="mr-1 flex -space-x-1 group-hover:hidden">
            {here.slice(0, 3).map((p) => <span key={p.clientId} title={p.name} className="size-2 rounded-full ring-2 ring-sidebar" style={{ background: p.color }} />)}
          </span>
        )}
        {!w.readOnly && (
          <span className="hidden items-center group-hover:flex group-focus-within:flex">
            <MenuButton items={menu} label="Page options" width={210} className="grid size-6 place-items-center rounded text-faint transition hover:bg-active hover:text-fg"><MoreHorizontal size={15} /></MenuButton>
            <button onClick={() => { setOpen(true); w.createPage(id) }} title="Add page inside" aria-label="Add page inside" className="grid size-6 place-items-center rounded text-faint transition hover:bg-active hover:text-fg"><Plus size={15} /></button>
          </span>
        )}
      </motion.div>
      <AnimatePresence initial={false}>
        {open && kids.length > 0 && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }} className="overflow-hidden">
            {kids.map((k) => <TreeItem key={k} id={k} depth={depth + 1} peers={peers} />)}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Status() {
  const { s } = useWorkspace()
  const st = s.net.status()
  const n = s.net.peers().length
  const online = n ? ` · ${n} online` : ''
  let tone: 'ok' | 'wait' | 'err', text: string
  if (st.server === 'connected') { tone = 'ok'; text = 'Saved to sync server' + online }
  else if (st.p2p) { tone = 'ok'; text = `Connected to ${st.p2p} peer${st.p2p > 1 ? 's' : ''}` }
  else if (st.server === 'connecting') { tone = 'wait'; text = 'Connecting…' }
  else if (st.server) { tone = 'err'; text = st.serverError || 'Sync server unreachable' }
  else if (n) { tone = 'ok'; text = 'Connected in this browser' }
  else { tone = st.error ? 'err' : 'wait'; text = st.error ? 'Working offline' : 'Looking for peers…' }
  return (
    <div className="flex items-center gap-2 px-2.5 py-0.5 text-xs text-muted" title={st.server ? 'Changes are saved encrypted on your sync server' : 'Changes sync directly between browsers'}>
      <span className="relative flex size-2">
        {tone !== 'err' && <span className={cn('absolute inset-0 rounded-full opacity-60', tone === 'ok' ? 'bg-[#30a46c]' : 'animate-ping bg-[#d6a100]')} />}
        <span className={cn('relative size-2 rounded-full', tone === 'ok' ? 'bg-[#30a46c]' : tone === 'wait' ? 'bg-[#d6a100]' : 'bg-danger')} />
      </span>
      <span className="truncate">{text}</span>
      {tone === 'ok' && <Check size={12} className="shrink-0 text-faint" />}
    </div>
  )
}

function ThemeSwitch() {
  const { theme } = useWorkspace()
  const opts = [
    { v: 'light' as const, icon: <Sun size={14} />, label: 'Light' },
    { v: 'system' as const, icon: <Monitor size={14} />, label: 'System' },
    { v: 'dark' as const, icon: <Moon size={14} />, label: 'Dark' },
  ]
  return (
    <div className="mt-2 flex rounded-lg bg-hover p-0.5" role="radiogroup" aria-label="Theme">
      {opts.map((o) => (
        <button key={o.v} role="radio" aria-checked={theme.choice === o.v} title={o.label} onClick={() => theme.setChoice(o.v)}
          className="relative grid h-7 flex-1 place-items-center rounded-md text-muted transition hover:text-fg">
          {theme.choice === o.v && <motion.span layoutId="theme-pill" className="absolute inset-0 rounded-md bg-surface shadow-sm" transition={{ type: 'spring', stiffness: 500, damping: 35 }} />}
          <span className="relative">{o.icon}</span>
        </button>
      ))}
    </div>
  )
}
