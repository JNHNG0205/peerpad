'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Search, FileText, Plus, Share2, Sun, Moon, CornerDownLeft } from 'lucide-react'
import { useWorkspace } from './workspace'
import { titleOf, iconOf, ancestorsOf, fragmentOf } from '@/lib/pages.ts'
import { cn } from './ui'

type Item = { id: string; label: string; sub?: string; icon: React.ReactNode; run: () => void; snippet?: string }

/** Ctrl+K: jump to a page (searches titles and page text) or run an action. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWorkspace()
  const { s } = w
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (open) { setQ(''); setActive(0); setTimeout(() => input.current?.focus(), 10) } }, [open])

  const items = useMemo<Item[]>(() => {
    if (!open) return []
    const query = q.trim().toLowerCase()
    const pages: Item[] = []
    s.pages.forEach((_p, id) => {
      const title = titleOf(s.pages, id)
      const path = ancestorsOf(s.pages, id).map((a) => titleOf(s.pages, a)).join(' / ')
      let snippet: string | undefined
      let match = !query || title.toLowerCase().includes(query)
      if (!match && query.length > 1) {
        const text = fragmentOf(s.doc, id).toString().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
        const at = text.toLowerCase().indexOf(query)
        if (at >= 0) { match = true; snippet = (at > 30 ? '…' : '') + text.slice(Math.max(0, at - 30), at + query.length + 50) }
      }
      if (match) pages.push({ id, label: title, sub: path || undefined, snippet, icon: iconOf(s.pages, id) || <FileText size={15} />, run: () => w.openPage(id) })
    })
    pages.sort((a, b) => Number(!!a.snippet) - Number(!!b.snippet))
    const actions: Item[] = [
      ...(w.readOnly ? [] : [{ id: 'new', label: query ? `New page “${q.trim()}”` : 'New page', icon: <Plus size={15} />, run: () => w.createPage(null, { title: q.trim() }) }]),
      { id: 'share', label: 'Share workspace', icon: <Share2 size={15} />, run: () => w.dialog('share') },
      { id: 'theme', label: w.theme.resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', icon: w.theme.resolved === 'dark' ? <Sun size={15} /> : <Moon size={15} />, run: () => w.theme.setChoice(w.theme.resolved === 'dark' ? 'light' : 'dark') },
    ].filter((a) => !query || a.label.toLowerCase().includes(query) || a.id === 'new')
    return [...pages.slice(0, 30), ...actions]
  }, [open, q, s, w])

  const pick = (it?: Item) => { if (!it) return; onClose(); it.run() }
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 px-4 pt-[12vh] backdrop-blur-[2px] dark:bg-black/50"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          <motion.div role="dialog" aria-label="Search" className="w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
            initial={{ opacity: 0, y: -10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 450, damping: 34 }}>
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Search size={17} className="text-faint" />
              <input ref={input} value={q} placeholder="Search pages or type a command…" aria-label="Search"
                onChange={(e) => { setQ(e.target.value); setActive(0) }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)) }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
                  else if (e.key === 'Enter') { e.preventDefault(); pick(items[active]) }
                  else if (e.key === 'Escape') onClose()
                }}
                className="h-14 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint" />
            </div>
            <div className="max-h-[50vh] overflow-y-auto p-1.5">
              {items.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted">No pages match “{q}”.</p>}
              {items.map((it, i) => (
                <button key={it.id} onMouseMove={() => setActive(i)} onClick={() => pick(it)}
                  className={cn('relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left', i === active && 'bg-hover')}>
                  <span className="grid w-5 shrink-0 place-items-center text-muted">{it.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{it.label}</span>
                    {(it.snippet || it.sub) && <span className="block truncate text-xs text-faint">{it.snippet || it.sub}</span>}
                  </span>
                  {i === active && <CornerDownLeft size={13} className="text-faint" />}
                </button>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
