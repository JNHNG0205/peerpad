'use client'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { SmilePlus, X } from 'lucide-react'
import dynamic from 'next/dynamic'
import type * as Y from 'yjs'
import { useWorkspace } from './workspace'
import { useY } from '@/lib/hooks.ts'
import { applyTitle, isLegacy } from '@/lib/pages.ts'
import { legacyBlocks, migratePage } from './convert'

const Editor = dynamic(() => import('./Editor'), { ssr: false, loading: () => <EditorSkeleton /> })

const EMOJI = '📄 📝 📌 📚 🗂️ 🗓️ ✅ 💡 🚀 🎯 🧪 🛠️ 📈 📊 🧭 🏠 🌱 🔥 ⭐ 🎨 🧠 💬 📦 🔒 🧾 🗺️ 🍳 🎵 ✈️ 🐞 🤝 👋 🏆 💼 🧩 ⚡'.split(' ')

export function PageView({ id }: { id: string }) {
  const w = useWorkspace()
  const { s } = w
  const page = s.pages.get(id)
  useY(page, false)
  const [mode, setMode] = useState<'live' | 'converting' | { preview: any[] }>(() => (isLegacy(s.doc, page, id) ? 'converting' : 'live'))

  // First-version pages: editors convert them once; viewers see a read-only preview.
  useEffect(() => {
    if (!isLegacy(s.doc, page, id)) { setMode('live'); return }
    let cancelled = false
    ;(async () => {
      if (w.readOnly) { const blocks = await legacyBlocks(s.doc, id); if (!cancelled) setMode({ preview: blocks }) }
      else { await migratePage(s.doc, id); if (!cancelled) setMode('live') }
    })()
    return () => { cancelled = true }
  }, [id, w.readOnly, s.doc, page])

  if (!page) return null
  return (
    <motion.article
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.2, 0.7, 0.2, 1] }}
      className="mx-auto w-full max-w-[760px] px-6 pb-[40vh] pt-10 max-[820px]:px-4 sm:pt-16"
    >
      <PageIcon page={page} />
      <Title text={page.get('title') as Y.Text} />
      <div className="mt-3">
        {mode === 'converting' ? <EditorSkeleton /> :
          mode === 'live' ? <Editor key={id} session={s} pageId={id} me={w.me} readOnly={w.readOnly} theme={w.theme.resolved} /> :
          <Editor key={id + ':preview'} session={s} pageId={id} me={w.me} readOnly theme={w.theme.resolved} initialContent={mode.preview} />}
      </div>
    </motion.article>
  )
}

function PageIcon({ page }: { page: Y.Map<any> }) {
  const w = useWorkspace()
  const [open, setOpen] = useState(false)
  const icon = page.get('icon') as string
  const set = (v: string) => { w.s.doc.transact(() => page.set('icon', v), 'local'); setOpen(false) }
  if (w.readOnly && !icon) return null
  return (
    <div className="relative mb-3">
      {icon ? (
        <motion.button whileHover={{ scale: w.readOnly ? 1 : 1.06, rotate: w.readOnly ? 0 : -3 }} whileTap={{ scale: 0.95 }}
          disabled={w.readOnly} onClick={() => setOpen((o) => !o)} aria-label="Change icon"
          className="text-[56px] leading-none">{icon}</motion.button>
      ) : (
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-faint opacity-60 transition hover:bg-hover hover:text-muted hover:opacity-100">
          <SmilePlus size={15} /> Add icon
        </button>
      )}
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <motion.div initial={{ opacity: 0, y: -6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.97 }}
              className="absolute left-0 top-full z-50 mt-2 w-[290px] rounded-xl border border-line bg-surface p-2 shadow-pop">
              <div className="grid grid-cols-8 gap-0.5">
                {EMOJI.map((e) => (
                  <button key={e} onClick={() => set(e)} className="grid size-8 place-items-center rounded-md text-xl transition hover:scale-110 hover:bg-hover">{e}</button>
                ))}
              </div>
              {icon && (
                <button onClick={() => set('')} className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md py-1.5 text-xs text-muted transition hover:bg-hover hover:text-danger">
                  <X size={12} /> Remove icon
                </button>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Page title, edited together in real time (merged character by character). */
function Title({ text }: { text: Y.Text }) {
  const w = useWorkspace()
  const ref = useRef<HTMLTextAreaElement>(null)
  const [value, setValue] = useState(() => text.toString())
  useEffect(() => {
    setValue(text.toString())
    const f = (e: Y.YTextEvent) => { if (e.transaction.origin !== ref.current) setValue(text.toString()) }
    text.observe(f)
    return () => text.unobserve(f)
  }, [text])
  useLayoutEffect(() => {
    const ta = ref.current
    if (ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px' }
  }, [value])
  useLayoutEffect(() => { if (!value && !w.readOnly) ref.current?.focus() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <textarea
      ref={ref} rows={1} value={value} readOnly={w.readOnly} placeholder="Untitled" aria-label="Page title"
      onChange={(e) => {
        const v = e.target.value.replace(/\n/g, ' ')
        setValue(v)
        w.s.doc.transact(() => applyTitle(text, v), ref.current)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault()
          ;(document.querySelector('.bn-editor') as HTMLElement | null)?.focus()
        }
      }}
      className="block w-full resize-none overflow-hidden bg-transparent text-[40px] font-bold leading-[1.15] tracking-[-0.025em] text-fg outline-none placeholder:text-faint/70 max-[820px]:text-[32px]"
    />
  )
}

function EditorSkeleton() {
  return (
    <div className="flex flex-col gap-3 pt-2" aria-label="Loading page">
      {[92, 78, 85, 40].map((wd, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-hover" style={{ width: `${wd}%`, animationDelay: `${i * 120}ms` }} />
      ))}
    </div>
  )
}
