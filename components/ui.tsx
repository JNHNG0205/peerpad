'use client'
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { X, Check } from 'lucide-react'

export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

/* ---------------- buttons ---------------- */
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'outline' | 'danger'; size?: 'sm' | 'md' | 'icon' }
export function Button({ variant = 'outline', size = 'md', className, ...p }: BtnProps) {
  return (
    <button
      {...p}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium transition-[background,color,box-shadow,transform] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' && 'h-8 px-3 text-[13px]',
        size === 'md' && 'h-9 px-3.5 text-sm',
        size === 'icon' && 'size-8',
        variant === 'primary' && 'bg-accent text-accent-fg shadow-sm hover:brightness-110',
        variant === 'outline' && 'border border-line bg-surface text-fg hover:bg-hover',
        variant === 'ghost' && 'text-muted hover:bg-hover hover:text-fg',
        variant === 'danger' && 'bg-danger text-white hover:brightness-110',
        className,
      )}
    />
  )
}

/* ---------------- modal ---------------- */
export function Modal({ open, onClose, title, children, footer, width = 'max-w-lg' }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return
    const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', f)
    return () => removeEventListener('keydown', f)
  }, [open, onClose])
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4 backdrop-blur-[2px] dark:bg-black/50"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog" aria-modal="true" aria-label={title}
            className={cn('w-full rounded-2xl border border-line bg-surface p-6 shadow-pop', width)}
            initial={{ opacity: 0, y: 12, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
              <button onClick={onClose} aria-label="Close" className="-mr-2 -mt-1 rounded-md p-1.5 text-muted transition hover:bg-hover hover:text-fg"><X size={16} /></button>
            </div>
            <div className="flex flex-col gap-3 text-sm">{children}</div>
            {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

/* ---------------- dropdown menu ---------------- */
export type MenuItem =
  | { label: string; icon?: ReactNode; hint?: string; danger?: boolean; checked?: boolean; onSelect: () => void }
  | { heading: string }
  | { separator: true }
export function Menu({ anchor, open, onClose, items, align = 'start', width = 240 }: { anchor: HTMLElement | null; open: boolean; onClose: () => void; items: MenuItem[]; align?: 'start' | 'end'; width?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  useLayoutEffect(() => {
    if (!open || !anchor) return
    const r = anchor.getBoundingClientRect()
    const h = ref.current?.offsetHeight || 200
    const top = r.bottom + 6 + h > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6
    const left = align === 'end' ? r.right - width : r.left
    setPos({ top, left: Math.max(8, Math.min(left, innerWidth - width - 8)) })
  }, [open, anchor, align, width])
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', down)
    addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); removeEventListener('keydown', key) }
  }, [open, onClose, anchor])
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref} role="menu"
          style={{ top: pos.top, left: pos.left, width }}
          className="fixed z-50 max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-pop"
          initial={{ opacity: 0, y: -4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4, scale: 0.98 }}
          transition={{ duration: 0.12 }}
        >
          {items.map((it, i) =>
            'separator' in it ? <div key={i} className="mx-1 my-1 h-px bg-line" /> :
            'heading' in it ? <div key={i} className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{it.heading}</div> :
            <button
              key={i} role="menuitem"
              onClick={() => { onClose(); it.onSelect() }}
              className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13.5px] transition-colors hover:bg-hover', it.danger ? 'text-danger' : 'text-fg')}
            >
              <span className="grid size-4 shrink-0 place-items-center text-muted [&>svg]:size-4">{it.icon}</span>
              <span className="flex-1 truncate">{it.label}</span>
              {it.hint && <span className="text-xs text-faint">{it.hint}</span>}
              {it.checked && <Check size={14} className="text-accent" />}
            </button>,
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
/** A button that opens a Menu. */
export function MenuButton({ items, children, className, align, width, label }: { items: MenuItem[] | (() => MenuItem[]); children: ReactNode; className?: string; align?: 'start' | 'end'; width?: number; label: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={ref} aria-label={label} title={label} aria-expanded={open} className={className} onClick={() => setOpen((o) => !o)}>{children}</button>
      <Menu anchor={ref.current} open={open} onClose={() => setOpen(false)} items={typeof items === 'function' ? (open ? items() : []) : items} align={align} width={width} />
    </>
  )
}

/* ---------------- toasts ---------------- */
type Toast = { id: number; text: string }
const ToastCtx = createContext<(text: string) => void>(() => {})
export const useToast = () => useContext(ToastCtx)
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((text: string) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-2), { id, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id} layout role="status"
              initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.96 }}
              className="rounded-xl bg-fg px-4 py-2.5 text-sm font-medium text-bg shadow-pop"
            >
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  )
}

/* ---------------- small pieces ---------------- */
export function Avatar({ name, color, size = 24, ring = true }: { name: string; color: string; size?: number; ring?: boolean }) {
  return (
    <span
      title={name}
      style={{ background: color, width: size, height: size, fontSize: size * 0.45 }}
      className={cn('grid shrink-0 place-items-center rounded-full font-semibold text-white', ring && 'ring-2 ring-bg')}
    >
      {(name || '?').trim()[0]?.toUpperCase()}
    </span>
  )
}
export function Field(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn('h-10 w-full min-w-0 rounded-lg border border-line bg-bg px-3 text-sm text-fg outline-none transition placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/20', props.className)} />
}
export async function copyText(text: string, toast: (t: string) => void) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard') } catch { toast('Select the text and press Ctrl+C to copy') }
}
