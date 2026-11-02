'use client'
import { AnimatePresence, motion } from 'motion/react'
import { PanelLeftOpen, Menu as MenuIcon, MoreHorizontal, Copy, Download, FilePlus2, FileUp, Trash2, Eye, Share2, Sparkles } from 'lucide-react'
import { useWorkspace } from './workspace'
import { useY, useNet } from '@/lib/hooks.ts'
import { ancestorsOf, titleOf, iconOf } from '@/lib/pages.ts'
import { Avatar, Button, MenuButton, type MenuItem } from './ui'

export function Topbar() {
  const w = useWorkspace()
  const { s, pageId } = w
  useY(s.pages, true, (evs) => evs.some((e) => e.path.length < 2 || e.path[1] !== 'blocks'))
  useNet(s.net)
  const here = s.net.peers().filter((p) => p.page === pageId)
  const crumbs = pageId && s.pages.has(pageId) ? [...ancestorsOf(s.pages, pageId), pageId] : []
  const menu = (): MenuItem[] => pageId ? [
    { label: 'Copy as Markdown', icon: <Copy />, onSelect: () => w.exportMarkdown(pageId, 'copy') },
    { label: 'Download Markdown', icon: <Download />, onSelect: () => w.exportMarkdown(pageId, 'download') },
    ...(w.readOnly ? [] : [
      { separator: true as const },
      { label: 'Add page inside', icon: <FilePlus2 />, onSelect: () => w.createPage(pageId) },
      { label: 'Import Markdown inside', icon: <FileUp />, onSelect: () => w.importMarkdown(pageId) },
      { separator: true as const },
      { label: 'Delete page', icon: <Trash2 />, danger: true, onSelect: () => w.askDeletePage(pageId) },
    ]),
  ] : []
  return (
    <header className="sticky top-0 z-30 border-b border-transparent bg-bg/80 pt-[env(safe-area-inset-top)] backdrop-blur-md supports-[backdrop-filter]:bg-bg/70">
      <div className="flex h-12 items-center gap-2 px-3 sm:px-4">
        {(!w.sidebar.open || w.sidebar.mobile) && (
          <button onClick={() => w.sidebar.setOpen(true)} aria-label="Show sidebar" title="Show sidebar (Ctrl+\)"
            className="grid size-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-hover hover:text-fg">
            {w.sidebar.mobile ? <MenuIcon size={18} /> : <PanelLeftOpen size={17} />}
          </button>
        )}
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-sm">
          {crumbs.map((id, i) => (
            <span key={id} className="flex min-w-0 items-center gap-0.5">
              {i > 0 && <span className="px-0.5 text-faint">/</span>}
              <button onClick={() => w.openPage(id)}
                className={`flex min-w-0 max-w-[220px] items-center gap-1.5 truncate rounded-md px-1.5 py-1 transition hover:bg-hover ${i === crumbs.length - 1 ? 'text-fg' : 'text-muted'}`}>
                {iconOf(s.pages, id) && <span className="shrink-0">{iconOf(s.pages, id)}</span>}
                <span className="truncate">{titleOf(s.pages, id)}</span>
              </button>
            </span>
          ))}
        </nav>
        <div className="flex items-center -space-x-1.5">
          <AnimatePresence>
            {here.slice(0, 5).map((p) => (
              <motion.span key={p.clientId} initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 500, damping: 28 }}>
                <Avatar name={`${p.name}${p.role === 'view' ? ' (viewing)' : ''}`} color={p.color} size={26} />
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
        {w.readOnly && (
          <span className="hidden items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-xs font-medium text-muted sm:flex" title="You opened a view-only link">
            <Eye size={12} /> View only
          </span>
        )}
        <Button variant="outline" size="sm" onClick={() => w.dialog('agents')} title="Connect Claude, Codex and other AI agents"><Sparkles size={14} className="text-accent" /> <span className="max-[520px]:hidden">AI agents</span></Button>
        <Button variant="primary" size="sm" onClick={() => w.dialog('share')}><Share2 size={14} /> <span className="max-[400px]:hidden">Share</span></Button>
        {pageId && (
          <MenuButton items={menu} label="Page options" align="end" width={230}
            className="grid size-8 place-items-center rounded-lg text-muted transition hover:bg-hover hover:text-fg">
            <MoreHorizontal size={18} />
          </MenuButton>
        )}
      </div>
    </header>
  )
}
