#!/usr/bin/env node
// PeerPad MCP server: lets AI tools (Claude, Codex, Cursor…) read and edit a PeerPad workspace.
// It joins the workspace like a teammate: it decrypts with the key in the invite link, so the
// sync server still only ever sees encrypted data. Run with Node 22.18+ (runs TypeScript directly).
//
// Env:
//   PEERPAD_INVITE    invite link from the app's Share button (required)
//   PEERPAD_AI_NAME   name shown to teammates (default "AI assistant")
//   PEERPAD_SYNC_URL  optional: reach the sync server at another address (e.g. http://peerpad:8787 in Docker)
//   TRANSPORT=http    serve Streamable HTTP instead of stdio, with:
//     PORT (3333), HOST (127.0.0.1), MCP_TOKEN (required), MCP_ALLOWED_HOSTS (comma list)
import { timingSafeEqual } from 'node:crypto'
import * as Y from 'yjs'
import * as z from 'zod/v4'
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { ServerBlockNoteEditor } from '@blocknote/server-util'
import { getDocument } from '@blocknote/server-util/dom'
import { serverTransport, loadSigner } from '../lib/remote.ts'
import { createServerSchema, parseRows } from '../lib/blocks.ts'
import { markdownToBlocks, blocksToMarkdown, inlineText } from '../lib/markdown.ts'
import {
  pagesOf, fragmentOf, titleOf, iconOf, parentOf, childrenOf, ancestorsOf, descendantsOf,
  addPage, removePages, applyTitle, isLegacy, legacyMarkdown,
} from '../lib/pages.ts'

const CHARACTER_LIMIT = 25000
const log = (...a: unknown[]) => console.error('[peerpad-mcp]', ...a) // stdout carries the protocol
const editor: any = ServerBlockNoteEditor.create({ schema: createServerSchema() } as any, getDocument())

/* ------------------------------------------------------------------ config */
type Invite = { ws: string; key: string; server: string; pk: string | null; sk: string | null }
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
export async function openWorkspace(cfg: Invite, aiName = 'AI assistant', aiColor = '#6e56cf') {
  const doc = new Y.Doc()
  const pages = pagesOf(doc)
  const meta = doc.getMap('meta')
  const signer = await loadSigner(cfg.pk, cfg.sk)
  const awareness = new Awareness(doc)
  const remote = serverTransport(doc, cfg.ws, cfg.key, cfg.server, String(doc.clientID), {
    onReady: () => remote.sendAwareness(encodeAwarenessUpdate(awareness, [doc.clientID])),
    onDisconnect: () => log('disconnected, retrying…'),
  }, signer)
  awareness.on('update', ({ added, updated, removed }: any, origin: unknown) => {
    if (origin === 'local' && [...added, ...updated, ...removed].includes(doc.clientID)) remote.sendAwareness(encodeAwarenessUpdate(awareness, [doc.clientID]))
  })
  const readOnly = () => remote.state.readOnly
  let idle: ReturnType<typeof setTimeout> | null = null
  const showActivity = (page: string | null) => {
    awareness.setLocalState({ user: { name: aiName, color: aiColor }, page, role: readOnly() ? 'view' : 'edit' })
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => awareness.setLocalState(null), 30000) // leave "People here" when idle
    idle.unref?.()
  }
  const ready = () => remote.whenReady()

  /** Run edits synchronously and wait until the sync server has stored them. */
  async function write<T>(fn: () => T, pageId: string | null = null): Promise<T> {
    await ready()
    if (readOnly()) throw new Error('This invite link is view-only, so changes are not allowed. Use a "Can edit" link (Share button in PeerPad) to let the AI edit.')
    const updates: Uint8Array[] = []
    const onUpdate = (u: Uint8Array, origin: unknown) => { if (origin !== 'srv') updates.push(u) }
    doc.on('update', onUpdate)
    let result: T
    try { result = doc.transact(fn, 'mcp') } finally { doc.off('update', onUpdate) }
    if (updates.length) {
      await Promise.race([
        remote.sendUpdate(Y.mergeUpdates(updates)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('The sync server did not confirm the save within 10 seconds. Try again.')), 10000)),
      ])
    }
    showActivity(pageId)
    return result!
  }
  return { doc, pages, meta, remote, ready, write, readOnly, showActivity, close: () => remote.close() }
}
type WS = Awaited<ReturnType<typeof openWorkspace>>

/* ------------------------------------------------------------------ page content helpers */
function getPage(W: WS, id: string) {
  const p = W.pages.get(id)
  if (!p) throw new Error(`No page with id "${id}". Call peerpad_list_pages or peerpad_search to find page ids.`)
  return p
}
/** Current blocks of a page (first-version pages are converted in memory). */
async function pageBlocks(W: WS, id: string): Promise<any[]> {
  const page = getPage(W, id)
  if (isLegacy(W.doc, page, id)) return markdownToBlocks(editor, legacyMarkdown(W.pages, page))
  return editor.yXmlFragmentToBlocks(fragmentOf(W.doc, id))
}
/** Write a page's blocks back; only the differences are applied, so teammates' edits elsewhere are kept. */
function setBlocks(W: WS, id: string, blocks: any[]) {
  const page = getPage(W, id)
  editor.blocksToYXmlFragment(blocks, fragmentOf(W.doc, id))
  if (page.get('v') !== 2) page.set('v', 2)
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
export function createServerFor(W: WS) {
  return () => {
    const server = new McpServer({ name: 'peerpad-mcp-server', version: '2.0.0' })
    const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }

    server.registerTool('peerpad_list_pages', {
      title: 'List pages',
      description: 'List every page in the PeerPad workspace as a tree with page ids and icons. Start here to find a page id. To find pages by their content, use peerpad_search.',
      inputSchema: z.strictObject({ response_format: ResponseFormat }),
      annotations: RO,
    }, async ({ response_format }) => {
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
      inputSchema: z.strictObject({
        page_id: PageId,
        offset: z.number().int().min(0).default(0).describe('Index of the first top-level block to return, for long pages'),
        limit: z.number().int().min(1).max(500).default(200).describe('Maximum number of top-level blocks to return'),
        response_format: ResponseFormat,
      }),
      annotations: RO,
    }, async ({ page_id, offset, limit, response_format }) => {
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
      inputSchema: z.strictObject({
        query: z.string().min(2).max(200).describe('Text to look for in page titles and content'),
        limit: z.number().int().min(1).max(100).default(30).describe('Maximum matches to return'),
        offset: z.number().int().min(0).default(0).describe('Matches to skip, for pagination'),
        response_format: ResponseFormat,
      }),
      annotations: RO,
    }, async ({ query, limit, offset, response_format }) => {
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
      inputSchema: z.strictObject({
        title: z.string().min(1).max(300).describe('Page title'),
        content_markdown: z.string().max(200000).default('').describe('Page body in Markdown; empty for a blank page'),
        parent_id: z.string().optional().describe('Put the page inside this page (page id); omit for a top-level page'),
        icon: z.string().max(8).default('').describe('Optional emoji icon, e.g. "📝"'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async ({ title, content_markdown, parent_id, icon }) => {
      await W.ready()
      if (parent_id) getPage(W, parent_id)
      const blocks = content_markdown.trim() ? await markdownToBlocks(editor, content_markdown) : []
      const id = await W.write(() => {
        const pid = addPage(W.pages, { parent: parent_id || null, title, icon })
        if (blocks.length) editor.blocksToYXmlFragment(blocks, fragmentOf(W.doc, pid))
        return pid
      })
      W.showActivity(id)
      return ok(`Created page "${title}" (id: ${id}) with ${blocks.length} block(s).`)
    })

    server.registerTool('peerpad_add_content', {
      title: 'Add content to page',
      description: 'Insert Markdown content into an existing page as new blocks: at the end (default), at the start, or right after a given block. Use this to append notes, tasks, tables or charts without touching existing text. ' + MD_HELP,
      inputSchema: z.strictObject({
        page_id: PageId,
        content_markdown: z.string().min(1).max(200000).describe('Markdown to insert'),
        position: z.enum(['end', 'start']).default('end').describe('Where to insert when after_block_id is not given'),
        after_block_id: z.string().optional().describe('Insert right after this block (id from peerpad_read_page)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async ({ page_id, content_markdown, position, after_block_id }) => {
      await W.ready()
      const blocks = await pageBlocks(W, page_id)
      const added = await markdownToBlocks(editor, content_markdown)
      if (!added.length) throw new Error('The Markdown contained no content to insert.')
      if (after_block_id) { const f = mustFind(blocks, after_block_id); f.list.splice(f.index + 1, 0, ...added) }
      else if (position === 'start') blocks.unshift(...added)
      else blocks.push(...added)
      await W.write(() => setBlocks(W, page_id, blocks), page_id)
      return ok(`Inserted ${added.length} block(s) into "${titleOf(W.pages, page_id)}". New block ids: ${added.map((b) => b.id).join(', ')}`)
    })

    server.registerTool('peerpad_update_block', {
      title: 'Update block',
      description: 'Change one block. Pass markdown to rewrite it (e.g. "## New heading" or "- [x] Done task"), checked to tick a to-do, or for charts chart_rows / chart_type / chart_title. Other blocks are not touched. Example: check off a to-do with checked=true.',
      inputSchema: z.strictObject({
        page_id: PageId,
        block_id: z.string().min(1).describe('Block id from peerpad_read_page'),
        markdown: z.string().max(100000).optional().describe('New content for this block in Markdown; may become several blocks'),
        checked: z.boolean().optional().describe('To-do blocks only'),
        chart_rows: z.array(z.array(z.string())).min(1).max(500).optional().describe('Chart blocks only: all cells, first row = header, e.g. [["Month","TVL"],["Oct","27"]]'),
        chart_type: z.enum(['bar', 'line']).optional().describe('Chart blocks only'),
        chart_title: z.string().max(300).optional().describe('Chart blocks only'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ page_id, block_id, markdown, checked, chart_rows, chart_type, chart_title }) => {
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
      await W.write(() => setBlocks(W, page_id, blocks), page_id)
      return ok(`Updated block ${block_id}: ${(await blockMd(mustFind(await pageBlocks(W, page_id), block_id).block)).slice(0, 300)}`)
    })

    server.registerTool('peerpad_delete_block', {
      title: 'Delete block',
      description: 'Delete one block (and anything nested inside it) from a page. Confirm with the user before deleting content they wrote.',
      inputSchema: z.strictObject({ page_id: PageId, block_id: z.string().min(1).describe('Block id from peerpad_read_page') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, async ({ page_id, block_id }) => {
      await W.ready()
      const blocks = await pageBlocks(W, page_id)
      const f = mustFind(blocks, block_id)
      const was = await blockMd(f.block)
      f.list.splice(f.index, 1)
      await W.write(() => setBlocks(W, page_id, blocks), page_id)
      return ok(`Deleted block ${block_id} (was: ${was.slice(0, 120)})`)
    })

    server.registerTool('peerpad_replace_page_content', {
      title: 'Replace page content',
      description: 'Replace ALL content of a page with new Markdown (the title stays). Use for rewrites or reformatting. For small changes prefer peerpad_update_block or peerpad_add_content, which keep teammates\' concurrent edits. ' + MD_HELP,
      inputSchema: z.strictObject({ page_id: PageId, content_markdown: z.string().max(200000).describe('The new page body in Markdown') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, async ({ page_id, content_markdown }) => {
      await W.ready()
      getPage(W, page_id)
      const blocks = await markdownToBlocks(editor, content_markdown)
      await W.write(() => setBlocks(W, page_id, blocks.length ? blocks : [{ type: 'paragraph' }]), page_id)
      return ok(`Replaced the content of "${titleOf(W.pages, page_id)}" with ${blocks.length} block(s).`)
    })

    server.registerTool('peerpad_update_page', {
      title: 'Update page',
      description: 'Rename a page, change its icon, or move it inside another page (or to the top level with parent_id=null). Only the fields you pass change.',
      inputSchema: z.strictObject({
        page_id: PageId,
        title: z.string().min(1).max(300).optional().describe('New title'),
        icon: z.string().max(8).optional().describe('New emoji icon, or "" to remove'),
        parent_id: z.string().nullable().optional().describe('Move inside this page id; null moves it to the top level'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ page_id, title, icon, parent_id }) => {
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
      inputSchema: z.strictObject({ page_id: PageId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, async ({ page_id }) => {
      await W.ready()
      getPage(W, page_id)
      const all = descendantsOf(W.pages, page_id)
      const names = all.map((id) => titleOf(W.pages, id))
      await W.write(() => removePages(W.doc, all))
      return ok(`Deleted ${all.length} page(s): ${names.join(', ')}`)
    })

    return server
  }
}

/* ------------------------------------------------------------------ transport */
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('peerpad-mcp.ts')
if (isMain) {
  const W = await openWorkspace(parseInvite(process.env.PEERPAD_INVITE), process.env.PEERPAD_AI_NAME || 'AI assistant')
  W.ready().then(() => log('connected', W.readOnly() ? '(view-only link)' : '')).catch((e) => log(e.message))
  const createServer = createServerFor(W)
  if (process.env.TRANSPORT === 'http') {
    const { createMcpExpressApp } = await import('@modelcontextprotocol/express')
    const { toNodeHandler } = await import('@modelcontextprotocol/node')
    const token = process.env.MCP_TOKEN
    if (!token || token.length < 24) { log('Set MCP_TOKEN to a random secret of at least 24 characters (e.g. `openssl rand -hex 24`).'); process.exit(1) }
    const host = process.env.HOST || '127.0.0.1'
    const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(',').map((s) => s.trim()).filter(Boolean)
    const app = createMcpExpressApp(allowedHosts?.length ? { host, allowedHosts } : { host })
    const nodeHandler = toNodeHandler(createMcpHandler(createServer))
    const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }
    // token as a Bearer header, or as the last path segment (for clients that only take a URL)
    const auth = (req: any, res: any, next: () => void) => {
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      if (same(bearer, token) || same(String(req.params.token || ''), token)) return next()
      res.status(401).json({ error: 'Missing or wrong MCP token.' })
    }
    app.all('/mcp', auth, (req: any, res: any) => void nodeHandler(req, res, req.body))
    app.all('/mcp/:token', auth, (req: any, res: any) => void nodeHandler(req, res, req.body))
    const port = Number(process.env.PORT || 3333)
    app.listen(port, host, () => log(`listening on http://${host}:${port}/mcp`))
  } else {
    serveStdio(createServer)
    // exit when the AI client that started us goes away (otherwise the sync connection keeps us alive)
    const bye = () => { W.close(); process.exit(0) }
    process.stdin.on('end', bye)
    process.stdin.on('close', bye)
    log('running on stdio')
  }
}
