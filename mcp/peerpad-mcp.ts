#!/usr/bin/env node
// PeerPad MCP server: lets AI tools (Claude, Codex, Cursor…) read and edit a PeerPad workspace.
// It joins the workspace like a teammate: it decrypts with the key in the invite link, so the
// sync server still only ever sees encrypted data. Run with Node 22.18+ (runs TypeScript directly).
//
// Two ways to run it:
//   TRANSPORT=http  AI connector service for every workspace on the server; people create their own
//                   connections in the app (AI agents). Env: PORT (3333), HOST (127.0.0.1),
//                   DATA_DIR (where connections are stored), MCP_ALLOWED_HOSTS, PUBLIC_URL (optional)
//   stdio           one workspace, started by a desktop AI app. Env: PEERPAD_INVITE (link from Share)
// Both: PEERPAD_AI_NAME (default "AI assistant"), PEERPAD_SYNC_URL (reach the sync server at another
// address, e.g. http://peerpad:8787 in Docker).
import { timingSafeEqual } from 'node:crypto'
import * as Y from 'yjs'
import * as z from 'zod/v4'
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { ServerBlockNoteEditor } from '@blocknote/server-util'
import { getDocument } from '@blocknote/server-util/dom'
import { serverConnection, loadSigner, type DocChannel } from '../lib/remote.ts'
import { createServerSchema, parseRows } from '../lib/blocks.ts'
import { markdownToBlocks, blocksToMarkdown, inlineText } from '../lib/markdown.ts'
import {
  pagesOf, fragmentOf, pageFragment, contentSource, PAGE_VERSION, titleOf, iconOf, parentOf, childrenOf, ancestorsOf,
  descendantsOf, addPage, removePages, applyTitle, legacyMarkdown,
} from '../lib/pages.ts'

const CHARACTER_LIMIT = 25000
const log = (...a: unknown[]) => console.error('[peerpad-mcp]', ...a) // stdout carries the protocol
const editor: any = ServerBlockNoteEditor.create({ schema: createServerSchema() } as any, getDocument())

/* ------------------------------------------------------------------ config */
export type Invite = { ws: string; key: string; server: string; pk: string | null; sk: string | null }
export function parseInvite(link: string | undefined): Invite {
  if (!link) throw new Error('Set PEERPAD_INVITE to the invite link from PeerPad (Share button).')
  let u: URL
  try { u = new URL(link.trim()) } catch { throw new Error('PEERPAD_INVITE is not a valid link.') }
  const p = new URLSearchParams(u.hash.slice(1))
  const ws = p.get('ws'), key = p.get('key')
  if (!ws || !key) throw new Error('PEERPAD_INVITE is missing ws= or key=. Copy a fresh link from the Share button.')
  const server = process.env.PEERPAD_SYNC_URL || p.get('srv') || (u.protocol.startsWith('http') ? (u.origin + u.pathname).replace(/\/(index\.html)?$/, '') : '')
  if (!server) throw new Error('The invite link has no sync server. Set one in PeerPad (workspace menu → Sync server) and copy a new link.')
  return { ws, key, server, pk: p.get('pk'), sk: p.get('sk') }
}

/* ------------------------------------------------------------------ one connected workspace */
// The root document (page list) is loaded on open; page documents are loaded when a tool needs them.
export async function openWorkspace(cfg: Invite, aiName = 'AI assistant', aiColor = '#6e56cf') {
  const doc = new Y.Doc()
  const pages = pagesOf(doc)
  const meta = doc.getMap('meta')
  const signer = await loadSigner(cfg.pk, cfg.sk)
  const awareness = new Awareness(doc)
  const conn = serverConnection(cfg.ws, cfg.key, cfg.server, String(doc.clientID), {
    onConnect: () => conn.sendAwareness(encodeAwarenessUpdate(awareness, [doc.clientID])),
    onDisconnect: () => log('disconnected, retrying…'),
  }, signer)
  const rootCh = conn.addDoc('root', doc)
  awareness.on('update', ({ added, updated, removed }: any, origin: unknown) => {
    if (origin === 'local' && [...added, ...updated, ...removed].includes(doc.clientID)) conn.sendAwareness(encodeAwarenessUpdate(awareness, [doc.clientID]))
  })
  const readOnly = () => conn.state.readOnly
  let idle: ReturnType<typeof setTimeout> | null = null
  const showActivity = (page: string | null) => {
    awareness.setLocalState({ user: { name: aiName, color: aiColor }, page, role: readOnly() ? 'view' : 'edit' })
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => awareness.setLocalState(null), 30000) // leave "People here" when idle
    idle.unref?.()
  }
  const ready = () => rootCh.whenReady()

  const pageDocs = new Map<string, Promise<{ doc: Y.Doc; ch: DocChannel }>>()
  /** A page's document, loaded from the server on first use. */
  function page(id: string) {
    let p = pageDocs.get(id)
    if (!p) {
      p = (async () => {
        const pd = new Y.Doc()
        pd.clientID = doc.clientID
        const ch = conn.addDoc(id, pd)
        await ch.whenReady()
        return { doc: pd, ch }
      })()
      p.catch(() => pageDocs.delete(id))
      pageDocs.set(id, p)
    }
    return p
  }

  /** Run edits on one document synchronously and wait until the server has stored them. */
  async function writeDoc<T>(target: Y.Doc, ch: DocChannel, fn: () => T, pageId: string | null): Promise<T> {
    if (readOnly()) throw new Error('This invite link is view-only, so changes are not allowed. Use a "Can edit" link (Share button in PeerPad) to let the AI edit.')
    const updates: Uint8Array[] = []
    const onUpdate = (u: Uint8Array, origin: unknown) => { if (origin !== 'srv') updates.push(u) }
    target.on('update', onUpdate)
    let result: T
    try { result = target.transact(fn, 'mcp') } finally { target.off('update', onUpdate) }
    if (updates.length) {
      await Promise.race([
        ch.sendUpdate(Y.mergeUpdates(updates)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('The server did not confirm the save within 10 seconds. Try again.')), 10000)),
      ])
    }
    showActivity(pageId)
    return result!
  }
  return {
    doc, pages, meta, conn, ready, readOnly, showActivity, page,
    /** edit the page list (titles, icons, structure) */
    async write<T>(fn: () => T, pageId: string | null = null): Promise<T> { await ready(); return writeDoc(doc, rootCh, fn, pageId) },
    /** edit a page's content */
    async writePage<T>(id: string, fn: (pageDoc: Y.Doc) => T): Promise<T> {
      await ready()
      const { doc: pd, ch } = await page(id)
      return writeDoc(pd, ch, () => fn(pd), id)
    },
    close: () => conn.close(),
  }
}
type WS = Awaited<ReturnType<typeof openWorkspace>>

/* ------------------------------------------------------------------ page content helpers */
function getPage(W: WS, id: string) {
  const p = W.pages.get(id)
  if (!p) throw new Error(`No page with id "${id}". Call peerpad_list_pages or peerpad_search to find page ids.`)
  return p
}
/** Current blocks of a page, whatever its format (older formats are read in place). */
async function pageBlocks(W: WS, id: string): Promise<any[]> {
  const page = getPage(W, id)
  const src = contentSource(W.doc, page, id)
  if (src === 'root') return editor.yXmlFragmentToBlocks(fragmentOf(W.doc, id))
  if (src === 'legacy') return markdownToBlocks(editor, legacyMarkdown(W.pages, page))
  return editor.yXmlFragmentToBlocks(pageFragment((await W.page(id)).doc))
}
/** Write a page's blocks back; only the differences are applied, so teammates' edits elsewhere are kept.
 * Pages in an older format are moved into their own document first. */
async function setBlocks(W: WS, id: string, blocks: any[]) {
  const page = getPage(W, id)
  const src = contentSource(W.doc, page, id)
  await W.writePage(id, (pd) => editor.blocksToYXmlFragment(blocks, pageFragment(pd)))
  if (src !== 'page') {
    await W.write(() => {
      if (src === 'root') { const old = fragmentOf(W.doc, id); old.delete(0, old.length) }
      page.set('v', PAGE_VERSION)
    }, id)
  }
}
function findBlock(blocks: any[], id: string): { list: any[]; index: number; block: any } | null {
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].id === id) return { list: blocks, index: i, block: blocks[i] }
    const inner = blocks[i].children?.length ? findBlock(blocks[i].children, id) : null
    if (inner) return inner
  }
  return null
}
const mustFind = (blocks: any[], id: string) => {
  const f = findBlock(blocks, id)
  if (!f) throw new Error(`No block "${id}" on this page. Call peerpad_read_page to see current block ids.`)
  return f
}
async function blockMd(b: any): Promise<string> {
  return (await blocksToMarkdown(editor, [{ ...b, children: [] }])).trim()
}
function plain(b: any): string {
  if (b.type === 'chart') return [b.props?.title, ...parseRows(b.props?.data).flat()].filter(Boolean).join(' ')
  return [inlineText(b.content), ...(b.children || []).map(plain)].join(' ')
}

const ok = (text: string, structured?: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text }], ...(structured ? { structuredContent: structured } : {}) })
const jsonOk = (data: Record<string, unknown>) => ok(JSON.stringify(data, null, 2), data)
const ResponseFormat = z.enum(['markdown', 'json']).default('markdown').describe("'markdown' for readable text, 'json' for structured data")
const PageId = z.string().min(1).describe('Page id, e.g. "k2j9x0a1b2c" (from peerpad_list_pages or peerpad_search)')
const MD_HELP = 'Markdown supported: # headings, - lists, 1. lists, - [ ] to-dos, > quotes, > 💡 callouts (any emoji), ``` code, ---, **bold** *italic* `code` [links](https://…), tables (| a | b |), images ![caption](https://…), table of contents [TOC], and charts as a ```chart block containing JSON like {"type":"bar","title":"TVL","rows":[["Month","USD M"],["Oct","27"],["Nov","48"]]} (type bar or line; first column labels, other columns one series each).'

/* ------------------------------------------------------------------ MCP tools */
/** Which workspaces a connection can use. One-workspace connections ignore the workspace argument. */
export type Resolver = { list(): { id: string; name: string; access: 'edit' | 'view' }[]; get(id?: string): Promise<WS> }
export const single = (W: WS): Resolver => ({
  list: () => [{ id: 'default', name: (W.meta.get('name') as string) || 'Shared workspace', access: W.readOnly() ? 'view' : 'edit' }],
  get: async () => W,
})
const WorkspaceParam = z.string().max(120).optional().describe('Workspace id or name from peerpad_list_workspaces. Only needed when this connection can use more than one workspace.')

export function createServerFor(R: Resolver) {
  return () => {
    const server = new McpServer({ name: 'peerpad-mcp-server', version: '2.1.0' })
    const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }

    server.registerTool('peerpad_list_workspaces', {
      title: 'List workspaces',
      description: 'List the PeerPad workspaces this connection can use, with their ids and access (edit or view). Pass a workspace id or name as `workspace` to the other tools when there is more than one.',
      inputSchema: z.strictObject({}),
      annotations: RO,
    }, async () => {
      const list = R.list()
      return ok(list.map((w) => `- ${w.name} (workspace: ${w.id}, ${w.access === 'edit' ? 'can edit' : 'view only'})`).join('\n'), { workspaces: list })
    })

    server.registerTool('peerpad_list_pages', {
      title: 'List pages',
      description: 'List every page in the PeerPad workspace as a tree with page ids and icons. Start here to find a page id. To find pages by their content, use peerpad_search.',
      inputSchema: z.strictObject({ workspace: WorkspaceParam, response_format: ResponseFormat }),
      annotations: RO,
    }, async ({ workspace, response_format }) => {
      const W = await R.get(workspace)
      await W.ready()
      const rows: { id: string; title: string; icon: string; parent_id: string | null; depth: number }[] = []
      const walk = (parent: string | null, depth: number) => childrenOf(W.pages, parent).forEach((id) => {
        rows.push({ id, title: titleOf(W.pages, id), icon: iconOf(W.pages, id), parent_id: parent, depth })
        walk(id, depth + 1)
      })
      walk(null, 0)
      const data = { workspace: (W.meta.get('name') as string) || 'Shared workspace', total: rows.length, read_only: W.readOnly(), pages: rows }
      if (response_format === 'json') return jsonOk(data)
      if (!rows.length) return ok(`Workspace "${data.workspace}" has no pages yet. Create one with peerpad_create_page.`)
      return ok([`# ${data.workspace} (${rows.length} pages${data.read_only ? ', view-only access' : ''})`, '',
        ...rows.map((r) => `${'  '.repeat(r.depth)}- ${r.icon ? r.icon + ' ' : ''}${r.title} (id: ${r.id})`)].join('\n'))
    })

    server.registerTool('peerpad_read_page', {
      title: 'Read page',
      description: 'Read one page: title, icon, location, and its blocks as Markdown. In markdown mode each top-level block starts with its block id in brackets, e.g. "[3f2a…] - Buy milk". Use those ids with peerpad_update_block, peerpad_delete_block, or as after_block_id in peerpad_add_content.',
      inputSchema: z.strictObject({ workspace: WorkspaceParam,
        page_id: PageId,
        offset: z.number().int().min(0).default(0).describe('Index of the first top-level block to return, for long pages'),
        limit: z.number().int().min(1).max(500).default(200).describe('Maximum number of top-level blocks to return'),
        response_format: ResponseFormat,
      }),
      annotations: RO,
    }, async ({ workspace, page_id, offset, limit, response_format }) => {
      const W = await R.get(workspace)
      await W.ready()
      getPage(W, page_id)
      const all = await pageBlocks(W, page_id)
      W.showActivity(page_id)
      const head = {
        id: page_id, title: titleOf(W.pages, page_id), icon: iconOf(W.pages, page_id),
        path: ancestorsOf(W.pages, page_id).map((a) => titleOf(W.pages, a)), parent_id: parentOf(W.pages, page_id),
        children: childrenOf(W.pages, page_id).map((id) => ({ id, title: titleOf(W.pages, id) })),
        total_blocks: all.length, offset,
      }
      let count = limit
      for (;;) {
        const slice = all.slice(offset, offset + count)
        const next = offset + slice.length
        const more = next < all.length ? { has_more: true, next_offset: next } : { has_more: false }
        let text: string, structured: Record<string, unknown> | undefined
        if (response_format === 'json') {
          structured = { ...head, blocks: slice, ...more }
          text = JSON.stringify(structured, null, 2)
        } else {
          const lines = [`# ${head.icon ? head.icon + ' ' : ''}${head.title}`, `Page id: ${page_id}${head.path.length ? ' · in: ' + head.path.join(' / ') : ''}`]
          if (head.children.length) lines.push('Sub-pages: ' + head.children.map((c) => `${c.title} (${c.id})`).join(', '))
          lines.push('')
          for (const b of slice) {
            const md = (await blocksToMarkdown(editor, [b])).trim()
            lines.push(`[${b.id}] ${md || '(empty ' + b.type + ')'}`)
          }
          if (!all.length) lines.push('(empty page)')
          if (more.has_more) lines.push('', `Showing blocks ${offset}–${next - 1} of ${all.length}. More: call again with offset=${next}.`)
          text = lines.join('\n')
        }
        if (text.length <= CHARACTER_LIMIT || count <= 1) return ok(text, structured)
        count = Math.ceil(count / 2)
      }
    })

    server.registerTool('peerpad_search', {
      title: 'Search workspace',
      description: 'Find pages and blocks containing some text (case-insensitive). Returns page ids, block ids and snippets. Example: query "launch checklist".',
      inputSchema: z.strictObject({ workspace: WorkspaceParam,
        query: z.string().min(2).max(200).describe('Text to look for in page titles and content'),
        limit: z.number().int().min(1).max(100).default(30).describe('Maximum matches to return'),
        offset: z.number().int().min(0).default(0).describe('Matches to skip, for pagination'),
        response_format: ResponseFormat,
      }),
      annotations: RO,
    }, async ({ workspace, query, limit, offset, response_format }) => {
      const W = await R.get(workspace)
      await W.ready()
      const q = query.toLowerCase()
      const hits: { page_id: string; page_title: string; block_id: string | null; snippet: string }[] = []
      for (const id of W.pages.keys()) {
        const t = titleOf(W.pages, id)
        if (t.toLowerCase().includes(q)) hits.push({ page_id: id, page_title: t, block_id: null, snippet: t })
        const walk = (bs: any[]) => bs.forEach((b) => {
          const text = plain(b)
          const at = text.toLowerCase().indexOf(q)
          if (at >= 0 && !(b.children || []).some((c: any) => plain(c).toLowerCase().includes(q))) {
            hits.push({ page_id: id, page_title: t, block_id: b.id, snippet: (at > 40 ? '…' : '') + text.slice(Math.max(0, at - 40), at + q.length + 80) })
          }
          if (b.children?.length) walk(b.children)
        })
        walk(await pageBlocks(W, id))
      }
      const slice = hits.slice(offset, offset + limit)
      const next = offset + slice.length
      const data = { total: hits.length, count: slice.length, offset, matches: slice, has_more: next < hits.length, ...(next < hits.length ? { next_offset: next } : {}) }
      if (response_format === 'json') return jsonOk(data)
      if (!hits.length) return ok(`No matches for "${query}". Try a shorter or different query, or call peerpad_list_pages.`)
      const lines = [`${hits.length} match(es) for "${query}":`, '', ...slice.map((h) => `- ${h.page_title} (page ${h.page_id})${h.block_id ? ` · block ${h.block_id}: ${h.snippet}` : ' · title match'}`)]
      if (data.has_more) lines.push('', `More results: call again with offset=${next}.`)
      return ok(lines.join('\n'))
    })

    server.registerTool('peerpad_create_page', {
      title: 'Create page',
      description: 'Create a new page, optionally inside another page, with content written in Markdown. Returns the new page id. Teammates see it appear live. ' + MD_HELP,
      inputSchema: z.strictObject({ workspace: WorkspaceParam,
        title: z.string().min(1).max(300).describe('Page title'),
        content_markdown: z.string().max(200000).default('').describe('Page body in Markdown; empty for a blank page'),
        parent_id: z.string().optional().describe('Put the page inside this page (page id); omit for a top-level page'),
        icon: z.string().max(8).default('').describe('Optional emoji icon, e.g. "📝"'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async ({ workspace, title, content_markdown, parent_id, icon }) => {
      const W = await R.get(workspace)
      await W.ready()
      if (parent_id) getPage(W, parent_id)
      const blocks = content_markdown.trim() ? await markdownToBlocks(editor, content_markdown) : []
      const id = await W.write(() => addPage(W.pages, { parent: parent_id || null, title, icon }))
      if (blocks.length) await W.writePage(id, (pd) => editor.blocksToYXmlFragment(blocks, pageFragment(pd)))
      W.showActivity(id)
      return ok(`Created page "${title}" (id: ${id}) with ${blocks.length} block(s).`)
    })

    server.registerTool('peerpad_add_content', {
      title: 'Add content to page',
      description: 'Insert Markdown content into an existing page as new blocks: at the end (default), at the start, or right after a given block. Use this to append notes, tasks, tables or charts without touching existing text. ' + MD_HELP,
      inputSchema: z.strictObject({ workspace: WorkspaceParam,
        page_id: PageId,
        content_markdown: z.string().min(1).max(200000).describe('Markdown to insert'),
        position: z.enum(['end', 'start']).default('end').describe('Where to insert when after_block_id is not given'),
        after_block_id: z.string().optional().describe('Insert right after this block (id from peerpad_read_page)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async ({ workspace, page_id, content_markdown, position, after_block_id }) => {
      const W = await R.get(workspace)
      await W.ready()
      const blocks = await pageBlocks(W, page_id)
      const added = await markdownToBlocks(editor, content_markdown)
      if (!added.length) throw new Error('The Markdown contained no content to insert.')
      if (after_block_id) { const f = mustFind(blocks, after_block_id); f.list.splice(f.index + 1, 0, ...added) }
      else if (position === 'start') blocks.unshift(...added)
      else blocks.push(...added)
      await setBlocks(W, page_id, blocks)
      return ok(`Inserted ${added.length} block(s) into "${titleOf(W.pages, page_id)}". New block ids: ${added.map((b) => b.id).join(', ')}`)
    })

    server.registerTool('peerpad_update_block', {
      title: 'Update block',
      description: 'Change one block. Pass markdown to rewrite it (e.g. "## New heading" or "- [x] Done task"), checked to tick a to-do, or for charts chart_rows / chart_type / chart_title. Other blocks are not touched. Example: check off a to-do with checked=true.',
      inputSchema: z.strictObject({ workspace: WorkspaceParam,
        page_id: PageId,
        block_id: z.string().min(1).describe('Block id from peerpad_read_page'),
        markdown: z.string().max(100000).optional().describe('New content for this block in Markdown; may become several blocks'),
        checked: z.boolean().optional().describe('To-do blocks only'),
        chart_rows: z.array(z.array(z.string())).min(1).max(500).optional().describe('Chart blocks only: all cells, first row = header, e.g. [["Month","TVL"],["Oct","27"]]'),
        chart_type: z.enum(['bar', 'line']).optional().describe('Chart blocks only'),
        chart_title: z.string().max(300).optional().describe('Chart blocks only'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ workspace, page_id, block_id, markdown, checked, chart_rows, chart_type, chart_title }) => {
      const W = await R.get(workspace)
      await W.ready()
      const blocks = await pageBlocks(W, page_id)
      const f = mustFind(blocks, block_id)
      const b = f.block
      if ((chart_rows || chart_type || chart_title !== undefined) && b.type !== 'chart') throw new Error(`Block ${block_id} is a ${b.type} block; chart_* fields only apply to chart blocks.`)
      if (checked !== undefined && b.type !== 'checkListItem') throw new Error(`Block ${block_id} is a ${b.type} block; checked only applies to to-do blocks.`)
      if (markdown !== undefined) {
        const repl = await markdownToBlocks(editor, markdown)
        if (!repl.length) throw new Error('The Markdown is empty. To remove the block, use peerpad_delete_block.')
        repl[0] = { ...repl[0], id: b.id, children: [...(repl[0].children || []), ...(b.children || [])] }
        f.list.splice(f.index, 1, ...repl)
      } else {
        f.list[f.index] = { ...b, props: { ...b.props,
          ...(checked !== undefined ? { checked } : {}),
          ...(chart_rows ? { data: JSON.stringify(chart_rows) } : {}),
          ...(chart_type ? { chartType: chart_type } : {}),
          ...(chart_title !== undefined ? { title: chart_title } : {}),
        } }
      }
      await setBlocks(W, page_id, blocks)
      return ok(`Updated block ${block_id}: ${(await blockMd(mustFind(await pageBlocks(W, page_id), block_id).block)).slice(0, 300)}`)
    })

    server.registerTool('peerpad_delete_block', {
      title: 'Delete block',
      description: 'Delete one block (and anything nested inside it) from a page. Confirm with the user before deleting content they wrote.',
      inputSchema: z.strictObject({ workspace: WorkspaceParam, page_id: PageId, block_id: z.string().min(1).describe('Block id from peerpad_read_page') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, async ({ workspace, page_id, block_id }) => {
      const W = await R.get(workspace)
      await W.ready()
      const blocks = await pageBlocks(W, page_id)
      const f = mustFind(blocks, block_id)
      const was = await blockMd(f.block)
      f.list.splice(f.index, 1)
      await setBlocks(W, page_id, blocks)
      return ok(`Deleted block ${block_id} (was: ${was.slice(0, 120)})`)
    })

    server.registerTool('peerpad_replace_page_content', {
      title: 'Replace page content',
      description: 'Replace ALL content of a page with new Markdown (the title stays). Use for rewrites or reformatting. For small changes prefer peerpad_update_block or peerpad_add_content, which keep teammates\' concurrent edits. ' + MD_HELP,
      inputSchema: z.strictObject({ workspace: WorkspaceParam, page_id: PageId, content_markdown: z.string().max(200000).describe('The new page body in Markdown') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, async ({ workspace, page_id, content_markdown }) => {
      const W = await R.get(workspace)
      await W.ready()
      getPage(W, page_id)
      const blocks = await markdownToBlocks(editor, content_markdown)
      await setBlocks(W, page_id, blocks.length ? blocks : [{ type: 'paragraph' }])
      return ok(`Replaced the content of "${titleOf(W.pages, page_id)}" with ${blocks.length} block(s).`)
    })

    server.registerTool('peerpad_update_page', {
      title: 'Update page',
      description: 'Rename a page, change its icon, or move it inside another page (or to the top level with parent_id=null). Only the fields you pass change.',
      inputSchema: z.strictObject({ workspace: WorkspaceParam,
        page_id: PageId,
        title: z.string().min(1).max(300).optional().describe('New title'),
        icon: z.string().max(8).optional().describe('New emoji icon, or "" to remove'),
        parent_id: z.string().nullable().optional().describe('Move inside this page id; null moves it to the top level'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ workspace, page_id, title, icon, parent_id }) => {
      const W = await R.get(workspace)
      await W.ready()
      const p = getPage(W, page_id)
      if (parent_id) {
        getPage(W, parent_id)
        if (descendantsOf(W.pages, page_id).includes(parent_id)) throw new Error('A page cannot be moved inside itself or one of its own sub-pages.')
      }
      await W.write(() => {
        if (title !== undefined) applyTitle(p.get('title'), title)
        if (icon !== undefined) p.set('icon', icon)
        if (parent_id !== undefined) { p.set('parent', parent_id); p.set('order', Date.now()) }
      }, page_id)
      const par = parentOf(W.pages, page_id)
      return ok(`Updated page ${page_id}: "${titleOf(W.pages, page_id)}"${par ? ` inside "${titleOf(W.pages, par)}"` : ' (top level)'}`)
    })

    server.registerTool('peerpad_delete_page', {
      title: 'Delete page',
      description: 'Delete a page and every page inside it, for everyone in the workspace. Confirm with the user first.',
      inputSchema: z.strictObject({ workspace: WorkspaceParam, page_id: PageId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, async ({ workspace, page_id }) => {
      const W = await R.get(workspace)
      await W.ready()
      getPage(W, page_id)
      const all = descendantsOf(W.pages, page_id)
      const names = all.map((id) => titleOf(W.pages, id))
      await W.write(() => removePages(W.doc, all))
      for (const id of all) W.conn.dropDoc(id)
      return ok(`Deleted ${all.length} page(s): ${names.join(', ')}`)
    })

    return server
  }
}

/* ------------------------------------------------------------------ transport */
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('peerpad-mcp.ts')
if (isMain && process.env.TRANSPORT === 'http') await serveHttp()
else if (isMain) {
  // stdio: one workspace, for AI apps that start the server themselves
  const W = await openWorkspace(parseInvite(process.env.PEERPAD_INVITE), process.env.PEERPAD_AI_NAME || 'AI assistant')
  W.ready().then(() => log('connected', W.readOnly() ? '(view-only link)' : '')).catch((e) => log(e.message))
  serveStdio(createServerFor(single(W)))
  // exit when the AI client that started us goes away (otherwise the sync connection keeps us alive)
  const bye = () => { W.close(); process.exit(0) }
  process.stdin.on('end', bye)
  process.stdin.on('close', bye)
  log('running on stdio')
}

/**
 * HTTP service:
 *   /mcp/agents/*      create, list and revoke AI agent connections (used by the app's "AI agents" dialog)
 *   /mcp/c/<token>     MCP endpoint of one connection (the address pasted into Claude, Codex, …)
 *   /mcp[/<MCP_TOKEN>] optional single-workspace endpoint when PEERPAD_INVITE and MCP_TOKEN are set
 */
async function serveHttp() {
  const { createMcpExpressApp } = await import('@modelcontextprotocol/express')
  const { toNodeHandler } = await import('@modelcontextprotocol/node')
  const { Connectors } = await import('./connectors.ts')
  const { proofMessage, PROOF_MAX_AGE_MS } = await import('../lib/agents.ts')
  const { unb64u } = await import('../lib/remote.ts')

  const host = process.env.HOST || '127.0.0.1'
  const port = Number(process.env.PORT || 3333)
  const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(',').map((x) => x.trim()).filter(Boolean)
  const app = createMcpExpressApp(allowedHosts?.length ? { host, allowedHosts } : { host })
  const { OAuthStore, OAuthError } = await import('./oauth.ts')
  const express = (await import('express')).default
  const dataDir = process.env.DATA_DIR || new URL('../data/mcp', import.meta.url).pathname
  const registry = new Connectors(dataDir)
  await registry.load()
  const oauth = new OAuthStore(dataDir)
  await oauth.load()
  log(`${registry.size} AI connection(s) registered`)
  const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }
  const publicBase = (req: any) => (process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/+$/, '')
  const fail = (res: any, status: number, error: string) => res.status(status).json({ error })

  // connections are opened on first use and closed after 10 idle minutes
  type Live = { W: WS; handler: (req: any, res: any, body: unknown) => Promise<void>; used: number }
  const live = new Map<string, Promise<Live>>()
  const getLive = (id: string, invite: Invite, name: string) => {
    let p = live.get(id)
    if (!p) {
      p = openWorkspace(invite, name).then((W) => ({ W, handler: toNodeHandler(createMcpHandler(createServerFor(single(W)))) as any, used: Date.now() }))
      p.catch(() => live.delete(id))
      live.set(id, p)
    }
    return p
  }
  const closeLive = async (id: string) => { const p = live.get(id); live.delete(id); if (p) (await p.catch(() => null))?.W.close() }
  setInterval(async () => {
    for (const [id, p] of live) { const l = await p.catch(() => null); if (!l || Date.now() - l.used > 10 * 60_000) closeLive(id) }
  }, 60_000).unref()

  // simple per-IP rate limit for creating connections
  const hits = new Map<string, number[]>()
  const limited = (ip: string, max = 20) => {
    const now = Date.now(), h = (hits.get(ip) || []).filter((t) => now - t < 3600_000)
    h.push(now); hits.set(ip, h)
    return h.length > max
  }
  async function verifyProof(body: any, action: 'list' | 'revoke' | 'revoke-all', id = '') {
    const { pk, ts, sig } = body || {}
    if (typeof pk !== 'string' || typeof sig !== 'string' || typeof ts !== 'number') return false
    if (Math.abs(Date.now() - ts) > PROOF_MAX_AGE_MS) return false
    const signer = await loadSigner(pk).catch(() => null)
    return !!signer && signer.verify(unb64u(sig), proofMessage(action, pk, ts, id))
  }

  app.use('/mcp/agents', (req: any, res: any, next: () => void) => {
    res.set({ 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' })
    if (req.method === 'OPTIONS') return res.status(204).end()
    next()
  })
  app.get('/mcp/agents/status', (_req: any, res: any) => res.json({ enabled: true }))

  app.post('/mcp/agents', async (req: any, res: any) => {
    if (limited(req.ip)) return fail(res, 429, 'Too many new AI connections from this network. Try again in an hour.')
    const { invite, name, agent, access } = req.body || {}
    if (!['claude', 'codex', 'other'].includes(agent) || !['edit', 'view'].includes(access)) return fail(res, 400, 'Choose an agent and an access level.')
    const label = String(name || '').trim().slice(0, 60) || 'AI assistant'
    let cfg: Invite
    try { cfg = parseInvite(invite) } catch (e) { return fail(res, 400, (e as Error).message) }
    if (access === 'edit' && !cfg.sk) return fail(res, 403, 'Your link can only view this workspace, so the AI can only get view access.')
    let W: WS | null = null
    try {
      W = await openWorkspace(access === 'view' ? { ...cfg, sk: null } : cfg, label)
      await W.ready()
      if (!W.pages.size && !W.meta.size) throw Object.assign(new Error('This workspace was not found on this server.'), { status: 404 })
      if (access === 'edit' && W.readOnly()) throw Object.assign(new Error('Your link can only view this workspace, so the AI can only get view access.'), { status: 403 })
    } catch (e: any) {
      W?.close()
      return fail(res, e.status || 502, e.message || 'Could not open the workspace.')
    }
    const { id, token, info } = await registry.create(access === 'view' ? { ...cfg, sk: null } : cfg, { name: label, agent, access })
    const handler = toNodeHandler(createMcpHandler(createServerFor(single(W)))) as any
    live.set(id, Promise.resolve({ W, handler, used: Date.now() }))
    log(`new AI connection ${id} (${agent}, ${access})`)
    res.status(201).json({ ...info, token, address: `${publicBase(req)}/mcp/c/${token}` })
  })

  app.post('/mcp/agents/list', async (req: any, res: any) => {
    if (!(await verifyProof(req.body, 'list'))) return fail(res, 403, 'Only editors can see all AI connections.')
    res.json({ connections: [...registry.listByPk(req.body.pk), ...oauth.listByPk(req.body.pk)].sort((a, b) => b.createdAt - a.createdAt) })
  })

  app.post('/mcp/agents/revoke', async (req: any, res: any) => {
    const { token, id } = req.body || {}
    // apps connected through sign-in (OAuth)
    if (typeof token === 'string' && token.startsWith('og.')) {
      const gid = await oauth.revokeByToken(token)
      if (!gid) return fail(res, 403, 'This connection was already removed.')
      for (const k of [...live.keys()]) if (k.startsWith(`oauth:${gid}:`)) await closeLive(k)
      grants.delete(gid)
      log(`revoked approval ${gid}`)
      return res.json({ revoked: gid })
    }
    if (typeof id === 'string' && id.includes(':')) {
      if (oauth.pkOf(id) !== req.body?.pk || !(await verifyProof(req.body, 'revoke', id))) return fail(res, 403, 'Only editors of this workspace can disconnect it.')
      await oauth.revokeEntry(id)
      await closeLive('oauth:' + id)
      grants.delete(id.split(':')[0])
      log(`revoked approval entry ${id}`)
      return res.json({ revoked: id })
    }
    let target: string | null = null
    if (typeof token === 'string') target = registry.unlock(token)?.id ?? null // the person who created it
    else if (typeof id === 'string' && registry.pkOf(id) === req.body?.pk && (await verifyProof(req.body, 'revoke', id))) target = id // any editor
    if (!target) return fail(res, 403, 'You can revoke connections you created, or any connection if you can edit this workspace.')
    await closeLive(target)
    await registry.remove([target])
    log(`revoked AI connection ${target}`)
    res.json({ revoked: target })
  })

  // the MCP endpoint of one connection
  app.all('/mcp/c/:token', async (req: any, res: any) => {
    const u = registry.unlock(req.params.token)
    if (!u) return fail(res, 404, 'This AI connection was revoked or does not exist. Create a new one in PeerPad (AI agents).')
    try {
      const l = await getLive(u.id, u.invite, u.info.name)
      l.used = Date.now()
      await l.handler(req, res, req.body)
    } catch (e) {
      if (!res.headersSent) fail(res, 502, (e as Error).message)
    }
  })

  /* ---------- sign-in for AI apps (OAuth 2.1, used by Claude, Codex and other MCP clients) ---------- */
  app.use('/mcp/oauth', express.urlencoded({ extended: false }), (req: any, res: any, next: () => void) => {
    res.set({ 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'cache-control': 'no-store' })
    if (req.method === 'OPTIONS') return res.status(204).end()
    next()
  })
  const oauthFail = (res: any, e: any) => {
    if (e instanceof OAuthError) return res.status(e.status).json({ error: e.code, error_description: e.message })
    log('oauth error:', e?.message)
    res.status(500).json({ error: 'server_error', error_description: 'Something went wrong. Try again.' })
  }
  app.post('/mcp/oauth/register', async (req: any, res: any) => {
    if (limited('reg:' + req.ip, 30)) return res.status(429).json({ error: 'slow_down', error_description: 'Too many registrations.' })
    try { res.status(201).json(await oauth.register(req.body)) } catch (e) { oauthFail(res, e) }
  })
  // the approval page asks which app is connecting
  app.get('/mcp/oauth/client', (req: any, res: any) => {
    try { res.json(oauth.client(String(req.query.client_id || ''), String(req.query.redirect_uri || ''))) } catch (e) { oauthFail(res, e) }
  })
  // the approval page sends the chosen workspaces (their links stay encrypted at rest, see oauth.ts)
  app.post('/mcp/oauth/approve', async (req: any, res: any) => {
    if (limited(req.ip)) return res.status(429).json({ error: 'slow_down', error_description: 'Too many approvals from this network. Try again in an hour.' })
    const b = req.body || {}
    if (b.resource && b.resource !== `${publicBase(req)}/mcp`) return res.status(400).json({ error: 'invalid_target', error_description: 'This approval is for another server.' })
    const chosen: { invite: Invite; access: 'edit' | 'view'; label: string; pk: string | null }[] = []
    for (const w of Array.isArray(b.workspaces) ? b.workspaces.slice(0, 20) : []) {
      let cfg: Invite
      try { cfg = parseInvite(w.invite) } catch (e) { return res.status(400).json({ error: 'invalid_request', error_description: (e as Error).message }) }
      const access = w.access === 'edit' ? 'edit' : 'view'
      if (access === 'edit' && !cfg.sk) return res.status(403).json({ error: 'access_denied', error_description: `You can only view "${w.label}", so the app can only get view access to it.` })
      // make sure the workspace exists here and the access is real
      const W = await openWorkspace(access === 'view' ? { ...cfg, sk: null } : cfg, 'checking').catch(() => null)
      try {
        await W?.ready()
        if (!W || (!W.pages.size && !W.meta.size)) return res.status(404).json({ error: 'invalid_request', error_description: `"${w.label}" was not found on this server.` })
        if (access === 'edit' && W.readOnly()) return res.status(403).json({ error: 'access_denied', error_description: `You can only view "${w.label}".` })
        chosen.push({ invite: cfg, access, label: String(w.label || (W.meta.get('name') as string) || 'Workspace'), pk: cfg.pk })
      } catch (e) {
        return res.status(502).json({ error: 'server_error', error_description: (e as Error).message })
      } finally { W?.close() }
    }
    try {
      res.json(await oauth.approve({ clientId: String(b.client_id || ''), redirectUri: String(b.redirect_uri || ''), challenge: String(b.code_challenge || ''), method: String(b.code_challenge_method || ''), resource: b.resource || null, workspaces: chosen }))
    } catch (e) { oauthFail(res, e) }
  })
  app.post('/mcp/oauth/token', async (req: any, res: any) => {
    try { res.json(await oauth.token(req.body)) } catch (e) { oauthFail(res, e) }
  })

  /* ---------- https://<server>/mcp : the one address AI apps connect to ---------- */
  type GrantLive = { key: string; handler: (req: any, res: any, body: unknown) => Promise<void> }
  const grants = new Map<string, GrantLive>()
  function grantHandler(u: NonNullable<ReturnType<typeof oauth.unlock>>): GrantLive {
    const key = u.workspaces.map((w) => w.entryId).join(',')
    const cached = grants.get(u.grantId)
    if (cached && cached.key === key) return cached
    const names = new Map<string, string>()
    const resolver: Resolver = {
      list: () => u.workspaces.map((w) => ({ id: w.entryId, name: names.get(w.entryId) || w.label, access: w.access })),
      async get(id?: string) {
        let w = u.workspaces.length === 1 && !id ? u.workspaces[0] : undefined
        if (!w && id) {
          const q = id.trim().toLowerCase()
          w = u.workspaces.find((x) => x.entryId === id) || u.workspaces.find((x) => (names.get(x.entryId) || x.label).toLowerCase() === q)
        }
        if (!w) throw new Error(`Choose a workspace: ${resolver.list().map((x) => `"${x.name}" (${x.id})`).join(', ')}. Pass it as the workspace argument; peerpad_list_workspaces lists them.`)
        const l = await getLive(`oauth:${u.grantId}:${w.entryId}`, w.invite, u.clientName)
        l.used = Date.now()
        const nm = l.W.meta.get('name') as string | undefined
        if (nm) names.set(w.entryId, nm)
        return l.W
      },
    }
    const g = { key, handler: toNodeHandler(createMcpHandler(createServerFor(resolver))) as any }
    grants.set(u.grantId, g)
    return g
  }
  // optional single-workspace endpoint from earlier setups (PEERPAD_INVITE + MCP_TOKEN in .env)
  let legacy: { token: string; handler: (req: any, res: any, body: unknown) => Promise<void> } | null = null
  if (process.env.PEERPAD_INVITE) {
    const token = process.env.MCP_TOKEN
    if (!token || token.length < 24) { log('PEERPAD_INVITE is set: also set MCP_TOKEN to a random secret of at least 24 characters (openssl rand -hex 24).'); process.exit(1) }
    const W = await openWorkspace(parseInvite(process.env.PEERPAD_INVITE), process.env.PEERPAD_AI_NAME || 'AI assistant')
    legacy = { token, handler: toNodeHandler(createMcpHandler(createServerFor(single(W)))) as any }
    app.all('/mcp/:token', (req: any, res: any) => {
      if (!same(String(req.params.token), token)) return fail(res, 401, 'Missing or wrong MCP token.')
      void legacy!.handler(req, res, req.body)
    })
    log('single-workspace endpoint enabled at /mcp/<MCP_TOKEN>')
  }
  app.all('/mcp', async (req: any, res: any) => {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (legacy && bearer && same(bearer, legacy.token)) return void legacy.handler(req, res, req.body)
    const u = bearer ? oauth.unlock(bearer) : null
    if (!u) {
      // tells the AI app where to sign in (OAuth discovery)
      res.set('WWW-Authenticate', `Bearer resource_metadata="${publicBase(req)}/.well-known/oauth-protected-resource/mcp"${bearer ? ', error="invalid_token"' : ''}`)
      return res.status(401).json({ error: 'invalid_token', error_description: 'Sign in to connect this app to PeerPad.' })
    }
    try { await grantHandler(u).handler(req, res, req.body) } catch (e) { if (!res.headersSent) fail(res, 502, (e as Error).message) }
  })

  app.listen(port, host, () => log(`listening on http://${host}:${port}`))
}
