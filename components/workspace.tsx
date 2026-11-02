'use client'
import { createContext, useContext } from 'react'
import type { Session, Me } from '@/lib/session.ts'
import type { ThemeChoice } from '@/lib/hooks.ts'

export type DialogName = 'share' | 'server' | 'profile' | 'join' | 'rename'
export type Confirm = { title: string; text: string; action: string; onConfirm: () => void }

export type Workspace = {
  s: Session
  me: Me
  setMe: (m: Me) => void
  readOnly: boolean
  pageId: string | null
  openPage: (id: string | null) => void
  createPage: (parent?: string | null, opts?: { title?: string; icon?: string; markdown?: string }) => string | null
  askDeletePage: (id: string) => void
  importMarkdown: (parent: string | null) => void
  exportMarkdown: (id: string, mode: 'copy' | 'download') => void
  theme: { choice: ThemeChoice; resolved: 'light' | 'dark'; setChoice: (c: ThemeChoice) => void }
  dialog: (name: DialogName) => void
  confirm: (c: Confirm) => void
  sidebar: { open: boolean; setOpen: (o: boolean) => void; mobile: boolean }
  palette: (open: boolean) => void
}

export const WorkspaceCtx = createContext<Workspace | null>(null)
export function useWorkspace(): Workspace {
  const w = useContext(WorkspaceCtx)
  if (!w) throw new Error('useWorkspace outside provider')
  return w
}
