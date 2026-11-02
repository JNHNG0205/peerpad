'use client'
import { useEffect, useReducer, useState, useCallback } from 'react'
import type * as Y from 'yjs'
import type { Net } from './sync.ts'

/** Re-render when a Yjs type (or anything inside it, with deep=true) changes. */
export function useY(type: Y.AbstractType<any> | null | undefined, deep = true, filter?: (events: Y.YEvent<any>[]) => boolean): number {
  const [v, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!type) return
    let raf = 0
    const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; bump() }) }
    if (deep) {
      const f = (events: Y.YEvent<any>[]) => { if (!filter || filter(events)) schedule() }
      type.observeDeep(f)
      return () => { type.unobserveDeep(f); cancelAnimationFrame(raf) }
    }
    type.observe(schedule)
    return () => { type.unobserve(schedule); cancelAnimationFrame(raf) }
  }, [type, deep, filter])
  return v
}

/** Re-render when presence or connection status changes (throttled). */
export function useNet(net: Net | null | undefined): number {
  const [v, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!net) return
    let t: ReturnType<typeof setTimeout> | null = null
    const off = net.onChange(() => { if (!t) t = setTimeout(() => { t = null; bump() }, 120) })
    const iv = setInterval(bump, 5000)
    return () => { off(); clearInterval(iv); if (t) clearTimeout(t) }
  }, [net])
  return v
}

export type ThemeChoice = 'system' | 'light' | 'dark'
/** Light/dark theme: follows the system unless the user picks one. */
export function useTheme(): { choice: ThemeChoice; resolved: 'light' | 'dark'; setChoice: (c: ThemeChoice) => void } {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => {
    try { return (localStorage.getItem('pp-theme') as ThemeChoice) || 'system' } catch { return 'system' }
  })
  const [systemDark, setSystemDark] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const f = () => setSystemDark(mq.matches)
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [])
  const resolved = choice === 'system' ? (systemDark ? 'dark' : 'light') : choice
  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark')
    document.documentElement.style.colorScheme = resolved
  }, [resolved])
  const setChoice = useCallback((c: ThemeChoice) => {
    setChoiceState(c)
    try { localStorage.setItem('pp-theme', c) } catch {}
  }, [])
  return { choice, resolved, setChoice }
}

/** True on narrow screens (sidebar becomes a drawer). */
export function useIsMobile(): boolean {
  const [m, setM] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 820px)').matches)
  useEffect(() => {
    const mq = matchMedia('(max-width: 820px)')
    const f = () => setM(mq.matches)
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [])
  return m
}
