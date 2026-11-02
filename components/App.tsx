'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { MantineProvider } from '@mantine/core'
import { FilePlus2, Users } from 'lucide-react'
import { startSession, loadMe, store, params, sessionHash, rememberWorkspace, type Session, type Me } from '@/lib/session.ts'
import { useTheme, useIsMobile, useY, useNet } from '@/lib/hooks.ts'
import { addPage, childrenOf, descendantsOf, removePages, titleOf } from '@/lib/pages.ts'
import { WorkspaceCtx, useWorkspace, type Workspace, type DialogName, type Confirm } from './workspace'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { PageView } from './PageView'
import { Dialogs } from './Dialogs'
import { CommandPalette } from './CommandPalette'
import { ToastProvider, useToast, Button } from './ui'
import { Splash } from './Splash'
import { writeMarkdown, pageMarkdown } from './convert'

const WELCOME = `> 👋 Everything here is end-to-end encrypted: your PeerPad server only ever stores scrambled data.

[TOC]

## Invite your team

1. Click **Share** in the top-right corner.
2. Copy a **Can edit** or **Can view** link and send it to a teammate.
3. Edit the same page together. You will see each other's cursors live.

## Writing

- [ ] Type \`/\` on an empty line to add headings, lists, tables, images, charts and more
- [ ] Select text to format it: **bold**, *italic*, \`code\`, [links](https://example.com)
- [x] Drag the ⋮⋮ handle to move blocks around

## Charts and tables

\`\`\`chart
{"type":"bar","title":"Pages written this week","rows":[["Day","Pages"],["Mon","3"],["Tue","5"],["Wed","4"],["Thu","8"],["Fri","6"]]}
\`\`\`

| Feature | Where to find it |
| --- | --- |
| Search | Ctrl+K |
| Dark mode | Bottom of the sidebar |
| AI agents (Claude, Codex) | AI agents button, top right |
`

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    startSession().then(setSession).catch((e) => setError(String(e?.message || e)))
    const onHash = () => { const p = params(); if (session && p.get('ws') && p.get('ws') !== session.ws) location.reload() }
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <Splash message={`Could not open the workspace: ${error}`} />
  if (!session) return <Splash />
  return (
    <MantineProvider>
      <ToastProvider>
        <Shell s={session} />
      </ToastProvider>
    </MantineProvider>
  )
}

function Shell({ s }: { s: Session }) {
  const toast = useToast()
  const theme = useTheme()
  const mobile = useIsMobile()
  const [me, setMeState] = useState<Me>(loadMe)
  const [pageId, setPageId] = useState<string | null>(() => params().get('p'))
  const [sidebarOpen, setSidebarOpen] = useState(() => !matchMedia('(max-width: 820px)').matches && store.get('pp-sidebar', true))
  const [dialog, setDialog] = useState<DialogName | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [palette, setPalette] = useState(false)
  useY(s.pages, true, (evs) => evs.some((e) => e.path.length === 0))
  useY(s.meta, false)
  useNet(s.net)
  const readOnly = s.readOnly || s.net.status().readOnly

  // a new workspace starts with a welcome page
  useEffect(() => {
    if (!s.createdHere || s.pages.size) return
    let id = ''
    s.doc.transact(() => {
      s.meta.set('name', me.name.split(' ')[0] + "'s workspace")
      id = addPage(s.pages, { title: 'Welcome to PeerPad', icon: '👋' })
    }, 'local')
    writeMarkdown(s, id, WELCOME).then(() => setPageId(id))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // keep the address bar, recent list and presence in sync with the open page
  const valid = pageId && s.pages.has(pageId) ? pageId : childrenOf(s.pages, null)[0] || null
  useEffect(() => {
    history.replaceState(null, '', '#' + sessionHash(s, valid))
    rememberWorkspace(s, (s.meta.get('name') as string) || 'Shared workspace')
    s.net.setPresence({ name: me.name, color: me.color, page: valid })
    document.title = valid ? `${titleOf(s.pages, valid)} · PeerPad` : 'PeerPad'
  })
  useEffect(() => {
    const onHash = () => { const p = params().get('p'); if (p && p !== pageId) setPageId(p) }
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [pageId])

  const openPage = useCallback((id: string | null) => {
    setPageId(id)
    if (matchMedia('(max-width: 820px)').matches) setSidebarOpen(false)
    scrollTo({ top: 0 })
  }, [])
  const createPage = useCallback((parent: string | null = null, opts: { title?: string; icon?: string; markdown?: string } = {}) => {
    if (readOnly) return null
    ;(document.activeElement as HTMLElement | null)?.blur?.() // keystrokes go to the new title, not the button
    let id = ''
    s.doc.transact(() => { id = addPage(s.pages, { parent, title: opts.title || '', icon: opts.icon || '' }) }, 'local')
    if (opts.markdown) writeMarkdown(s, id, opts.markdown)
    openPage(id)
    return id
  }, [s, readOnly, openPage])
  const askDeletePage = useCallback((id: string) => {
    const all = descendantsOf(s.pages, id)
    setConfirm({
      title: `Delete “${titleOf(s.pages, id)}”?`,
      text: all.length > 1 ? `This also deletes ${all.length - 1} page(s) inside it, for everyone in the workspace.` : 'This deletes the page for everyone in the workspace.',
      action: 'Delete',
      onConfirm: () => {
        s.doc.transact(() => removePages(s.doc, all), 'local')
        s.net.dropPages(all)
        if (pageId && all.includes(pageId)) setPageId(null)
        toast('Page deleted')
      },
    })
  }, [s, pageId, toast])
  const importMarkdown = useCallback((parent: string | null) => {
    const inp = document.createElement('input')
    inp.type = 'file'; inp.accept = '.md,.markdown,.txt,text/markdown,text/plain'; inp.multiple = true
    inp.onchange = async () => {
      let last: string | null = null
      for (const f of Array.from(inp.files || [])) {
        const text = await f.text()
        const m = text.match(/^\s*#\s+(.+)\n?/)
        let id = ''
        s.doc.transact(() => { id = addPage(s.pages, { parent, title: m ? m[1].trim() : f.name.replace(/\.(md|markdown|txt)$/i, '') }) }, 'local')
        await writeMarkdown(s, id, m ? text.slice(m[0].length) : text)
        last = id
      }
      if (last) { openPage(last); toast((inp.files?.length || 0) > 1 ? `Imported ${inp.files?.length} pages` : 'Page imported') }
    }
    inp.click()
  }, [s, openPage, toast])
  const exportMarkdown = useCallback(async (id: string, mode: 'copy' | 'download') => {
    const md = `# ${titleOf(s.pages, id)}\n\n` + (await pageMarkdown(s, id))
    if (mode === 'copy') {
      try { await navigator.clipboard.writeText(md); toast('Copied as Markdown') } catch { toast('Copy failed') }
    } else {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
      a.download = titleOf(s.pages, id).replace(/[\\/:*?"<>|]/g, '_') + '.md'
      a.click()
    }
  }, [s, toast])
  const setMe = useCallback((m: Me) => { setMeState(m); store.set('pp-me', m) }, [])
  const setOpen = useCallback((o: boolean) => { setSidebarOpen(o); if (!matchMedia('(max-width: 820px)').matches) store.set('pp-sidebar', o) }, [])

  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p) }
      else if (mod && e.key === '\\') { e.preventDefault(); setSidebarOpen((o) => !o) }
    }
    addEventListener('keydown', f)
    return () => removeEventListener('keydown', f)
  }, [])

  const w: Workspace = useMemo(() => ({
    s, me, setMe, readOnly, pageId: valid, openPage, createPage, askDeletePage, importMarkdown, exportMarkdown,
    theme, dialog: setDialog, confirm: setConfirm, sidebar: { open: sidebarOpen, setOpen, mobile }, palette: setPalette,
  }), [s, me, setMe, readOnly, valid, openPage, createPage, askDeletePage, importMarkdown, exportMarkdown, theme, sidebarOpen, setOpen, mobile])

  return (
    <WorkspaceCtx.Provider value={w}>
      <div className="flex min-h-dvh">
        {!mobile && (
          <motion.aside initial={false} animate={{ width: sidebarOpen ? 264 : 0 }} transition={{ type: 'spring', stiffness: 400, damping: 40 }}
            className="sticky top-0 h-dvh shrink-0 overflow-hidden border-r border-line bg-sidebar" aria-label="Sidebar">
            <div className="h-full w-[264px]"><Sidebar /></div>
          </motion.aside>
        )}
        {mobile && (
          <AnimatePresence>
            {sidebarOpen && (
              <>
                <motion.div className="fixed inset-0 z-40 bg-black/30" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSidebarOpen(false)} />
                <motion.aside initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }} transition={{ type: 'spring', stiffness: 380, damping: 38 }}
                  className="fixed inset-y-0 left-0 z-50 w-[min(300px,86vw)] border-r border-line bg-sidebar pl-[env(safe-area-inset-left)] shadow-pop" aria-label="Sidebar">
                  <Sidebar />
                </motion.aside>
              </>
            )}
          </AnimatePresence>
        )}
        <main className="min-w-0 flex-1 pr-[env(safe-area-inset-right)] max-[820px]:pl-[env(safe-area-inset-left)]">
          <Topbar />
          {/* new pages mount immediately (an exit animation would delay focus on the new title) */}
          {valid ? <PageView key={valid} id={valid} /> : <Empty key="empty" />}
        </main>
      </div>
      <Dialogs open={dialog} close={() => setDialog(null)} confirm={confirm} closeConfirm={() => setConfirm(null)} />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </WorkspaceCtx.Provider>
  )
}

function Empty() {
  const w = useWorkspace()
  const st = w.s.net.status()
  const syncing = st.server === 'connected'
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
      className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 pt-[18vh] text-center">
      <div className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent"><Users size={26} /></div>
      <h1 className="text-2xl font-bold tracking-tight">{syncing || w.s.createdHere ? 'No pages yet' : st.server ? 'Connecting to the server…' : 'Not connected to a server'}</h1>
      <p className="text-sm text-muted">
        {syncing || w.s.createdHere
          ? 'Create the first page of this workspace.'
          : st.server
            ? 'Pages appear as soon as the connection is ready. Anything you write meanwhile is kept and uploaded.'
            : 'Open this workspace from your PeerPad server\'s address, or set the server in workspace menu → Server.'}
      </p>
      {!w.readOnly && <Button variant="primary" className="mt-2" onClick={() => w.createPage(null)}><FilePlus2 size={15} /> Create a page</Button>}
    </motion.div>
  )
}
