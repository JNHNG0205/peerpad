#!/usr/bin/env node
// PeerPad MCP server: lets AI tools (Claude Desktop, Claude Code, Cursor, claude.ai…) read and
// edit a PeerPad workspace. It joins the workspace like a teammate: it decrypts with the key in
// the invite link, so the sync server still only ever sees encrypted data.
//
// Env:
//   PEERPAD_INVITE   invite link from the app's Share button (required)
//   PEERPAD_AI_NAME  name shown to teammates (default "AI assistant")
//   TRANSPORT=http   serve Streamable HTTP instead of stdio, with:
//     PORT (3333), HOST (127.0.0.1), MCP_TOKEN (required), MCP_ALLOWED_HOSTS (comma list)
import { timingSafeEqual } from 'node:crypto'
import * as Y from 'yjs'
import * as z from 'zod/v4'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { serverTransport, newTabId } from '../src/remote.js'

const CHARACTER_LIMIT = 25000
const log = (...a) => console.error('[peerpad-mcp]', ...a) // stdout carries the protocol

/* ------------------------------------------------------------------ config */
function parseInvite(link) {
  if (!link) throw new Error('Set PEERPAD_INVITE to the invite link from PeerPad (Share button).')
  let u
  try { u = new URL(link.trim()) } catch { throw new Error('PEERPAD_INVITE is not a valid link.') }
  const p = new URLSearchParams(u.hash.slice(1))
  const ws = p.get('ws'), key = p.get('key')
  if (!ws || !key) throw new Error('PEERPAD_INVITE is missing ws= or key=. Copy a fresh link from the Share button.')
  const server = p.get('srv') || (u.protocol.startsWith('http') ? (u.origin + u.pathname).replace(/\/(index\.html)?$/, '') : null)
  if (!server) throw new Error('The invite link has no sync server. Set one in PeerPad (workspace menu → Sync server…) and copy a new link.')
  return { ws, key, server }
}
const cfg = parseInvite(process.env.PEERPAD_INVITE)
const AI_NAME = process.env.PEERPAD_AI_NAME || 'AI assistant'
const AI_COLOR = '#6e56cf'

/* ------------------------------------------------------------------ workspace */
const doc = new Y.Doc()
const pages = doc.getMap('pages')
const meta = doc.getMap('meta')
const tab = newTabId()
const remote = serverTransport(doc, cfg.ws, cfg.key, cfg.server, tab, {
  onReady: () => log('connected to', cfg.server),
  onDisconnect: () => log('disconnected, retrying…'),
})

let activePage = null, lastActive = 0
const presence = () => ({ name: AI_NAME, color: AI_COLOR, page: activePage, block: null, tab })
setInterval(() => { if (Date.now() - lastActive < 30000) remote.sendPresence(presence()) }, 8000).unref?.()

async function ready() {
  await remote.whenReady()
}
/** Run edits in one transaction and wait until the sync server has stored them. */
async function write(fn, pageId = null) {
  await ready()
  const updates = []
  const onUpdate = (u, origin) => { if (origin === 'mcp') updates.push(u) }
  doc.on('update', onUpdate)
  let result
  try { doc.transact(() => { result = fn() }, 'mcp') } finally { doc.off('update', onUpdate) }
  if (updates.length) {
    await Promise.race([
      remote.sendUpdate(Y.mergeUpdates(updates)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('The sync server did not confirm the save within 10 seconds. Try again.')), 10000)),
    ])
  }
  if (pageId) { activePage = pageId; lastActive = Date.now(); remote.sendPresence(presence()) }
  return result
}

const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4)
const TYPES = ['p', 'h1', 'h2', 'h3', 'bullet', 'number', 'todo', 'quote', 'callout', 'code', 'divider']
function makeBlock({ type = 'p', text = '', checked = false, indent = 0 } = {}) {
  const m = new Y.Map()
  m.set('id', uid()); m.set('type', type); m.set('text', new Y.Text(text))
  m.set('checked', !!checked); m.set('indent', indent)
  return m
}
function applyDiff(ytext, next) {
  const prev = ytext.toString()
  if (prev === next) return
  let a = 0
  const max = Math.min(prev.length, next.length)
  while (a < max && prev[a] === next[a]) a++
  let b = 0
  while (b < max - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++
  if (prev.length - a - b) ytext.delete(a, prev.length - a - b)
  const ins = next.slice(a, next.length - b)
  if (ins) ytext.insert(a, ins)
}

/** Markdown -> block specs (same block types as the editor). */
function parseMarkdown(md) {
  const out = []
  const lines = String(md).replace(/\r/g, '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s*```/.test(l)) {
      const body = []
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i])
      out.push({ type: 'code', text: body.join('\n') })
      continue
    }
    if (!l.trim()) continue
    const indent = Math.min(6, Math.floor(l.match(/^\s*/)[0].replace(/\t/g, '  ').length / 2))
    const t = l.trim()
    let m
    if (/^(---|\*\*\*|___)$/.test(t)) out.push({ type: 'divider' })
    else if ((m = t.match(/^(#{1,3})\s+(.*)$/))) out.push({ type: 'h' + m[1].length, text: m[2] })
    else if ((m = t.match(/^[-*+]\s+\[([ xX])\]\s*(.*)$/))) out.push({ type: 'todo', text: m[2], checked: m[1] !== ' ', indent })
    else if ((m = t.match(/^[-*+]\s+(.*)$/))) out.push({ type: 'bullet', text: m[1], indent })
    else if ((m = t.match(/^\d+[.)]\s+(.*)$/))) out.push({ type: 'number', text: m[1], indent })
    else if ((m = t.match(/^>\s?💡\s?(.*)$/))) out.push({ type: 'callout', text: m[1] })
    else if ((m = t.match(/^>\s?(.*)$/))) out.push({ type: 'quote', text: m[1] })
    else out.push({ type: 'p', text: t })
  }
  return out
}

/* ------------------------------------------------------------------ read helpers */
const title = (id) => pages.get(id)?.get('title')?.toString().trim() || 'Untitled'
const icon = (id) => pages.get(id)?.get('icon') || ''
const parentOf = (id) => { const p = pages.get(id)?.get('parent'); return p && pages.has(p) ? p : null }
const childrenOf = (parent) => [...pages.keys()].filter((id) => parentOf(id) === parent)
  .sort((a, b) => (pages.get(a).get('order') || 0) - (pages.get(b).get('order') || 0))
function pathOf(id) {
  const out = []
  let p = parentOf(id), g = 0
  while (p && g++ < 50) { out.unshift(title(p)); p = parentOf(p) }
  return out
}
function getPage(id) {
  const p = pages.get(id)
  if (!p) throw new Error(`No page with id "${id}". Call peerpad_list_pages or peerpad_search to find page ids.`)
  return p
}
function findBlock(page, blockId) {
  const arr = page.get('blocks').toArray()
  const i = arr.findIndex((b) => b.get('id') === blockId)
  if (i < 0) throw new Error(`No block "${blockId}" on this page. Call peerpad_read_page to see current block ids.`)
  return { i, b: arr[i] }
}
function blockJSON(b) {
  return { id: b.get('id'), type: b.get('type'), text: b.get('text')?.toString() ?? '', checked: !!b.get('checked'), indent: b.get('indent') || 0, ...(b.get('ref') ? { page_ref: b.get('ref') } : {}) }
}
function blockMd(b, n) {
  const t = b.get('text')?.toString() ?? ''
  const pad = '  '.repeat(b.get('indent') || 0)
  switch (b.get('type')) {
    case 'h1': return `# ${t}`
    case 'h2': return `## ${t}`
    case 'h3': return `### ${t}`
    case 'bullet': return `${pad}- ${t}`
    case 'number': return `${pad}${n}. ${t}`
    case 'todo': return `${pad}- [${b.get('checked') ? 'x' : ' '}] ${t}`
    case 'quote': return `> ${t}`
    case 'callout': return `> 💡 ${t}`
    case 'code': return '```\n' + t + '\n```'
    case 'divider': return '---'
    case 'pagelink': return `→ sub-page "${title(b.get('ref'))}" (page id: ${b.get('ref')})`
    default: return `${pad}${t}`
  }
}
const ok = (text, structured) => ({ content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) })
const jsonOk = (data) => ok(JSON.stringify(data, null, 2), data)
const ResponseFormat = z.enum(['markdown', 'json']).default('markdown').describe("'markdown' for readable text, 'json' for structured data")
const PageId = z.string().min(1).describe('Page id, e.g. "k2j9x0a1b2c" (from peerpad_list_pages or peerpad_search)')
const BlockType = z.enum(TYPES).describe('p=text, h1-h3=headings, bullet, number, todo, quote, callout, code, divider')

/* ------------------------------------------------------------------ server */
function createServer() {
  const server = new McpServer({ name: 'peerpad-mcp-server', version: '1.0.0' })
  const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }

  server.registerTool('peerpad_list_pages', {
    title: 'List pages',
    description: 'List every page in the PeerPad workspace as a tree with page ids, icons and block counts. Start here to find a page id. To find pages by their content, use peerpad_search.',
    inputSchema: z.strictObject({ response_format: ResponseFormat }),
    annotations: RO,
  }, async ({ response_format }) => {
    await ready()
    const rows = []
    const walk = (parent, depth) => childrenOf(parent).forEach((id) => {
      rows.push({ id, title: title(id), icon: icon(id), parent_id: parent, depth, blocks: pages.get(id).get('blocks')?.length || 0 })
      walk(id, depth + 1)
    })
    walk(null, 0)
    const data = { workspace: meta.get('name') || 'Shared workspace', total: rows.length, pages: rows }
    if (response_format === 'json') return jsonOk(data)
    if (!rows.length) return ok(`Workspace "${data.workspace}" has no pages yet. Create one with peerpad_create_page.`)
    return ok([`# ${data.workspace} (${rows.length} pages)`, '', ...rows.map((r) => `${'  '.repeat(r.depth)}- ${r.icon ? r.icon + ' ' : ''}${r.title} (id: ${r.id}, ${r.blocks} blocks)`)].join('\n'))
  })

  server.registerTool('peerpad_read_page', {
    title: 'Read page',
    description: 'Read one page: title, icon, location, and its blocks. In markdown mode each block line starts with its block id in brackets, e.g. "[a1b2c3d] - Buy milk". Use those ids with peerpad_update_block, peerpad_delete_block, or as after_block_id in peerpad_add_content.',
    inputSchema: z.strictObject({
      page_id: PageId,
      offset: z.number().int().min(0).default(0).describe('Index of the first block to return, for long pages'),
      limit: z.number().int().min(1).max(500).default(200).describe('Maximum number of blocks to return'),
      response_format: ResponseFormat,
    }),
    annotations: RO,
  }, async ({ page_id, offset, limit, response_format }) => {
    await ready()
    const p = getPage(page_id)
    const all = p.get('blocks').toArray()
    // numbering for numbered lists, computed over the whole page
    const nums = []
    let stack = []
    for (const b of all) {
      const ind = b.get('indent') || 0
      stack.length = ind + 1
      stack[ind] = b.get('type') === 'number' ? (stack[ind] || 0) + 1 : 0
      nums.push(stack[ind])
    }
    const render = (count) => {
      const slice = all.slice(offset, offset + count)
      const next = offset + slice.length
      const page = {
        id: page_id, title: title(page_id), icon: icon(page_id), path: pathOf(page_id), parent_id: parentOf(page_id),
        children: childrenOf(page_id).map((id) => ({ id, title: title(id) })),
        total_blocks: all.length, offset, blocks: slice.map(blockJSON),
        has_more: next < all.length, ...(next < all.length ? { next_offset: next } : {}),
      }
      if (response_format === 'json') return { page, text: JSON.stringify(page, null, 2) }
      const lines = [`# ${page.icon ? page.icon + ' ' : ''}${page.title}`, `Page id: ${page_id}${page.path.length ? ' · in: ' + page.path.join(' / ') : ''}`]
      if (page.children.length) lines.push('Sub-pages: ' + page.children.map((c) => `${c.title} (${c.id})`).join(', '))
      lines.push('')
      slice.forEach((b, j) => lines.push(`[${b.get('id')}] ${blockMd(b, nums[offset + j])}`))
      if (!all.length) lines.push('(empty page)')
      if (page.has_more) lines.push('', `Showing blocks ${offset}–${next - 1} of ${all.length}. More: call again with offset=${next}.`)
      return { page, text: lines.join('\n') }
    }
    let count = limit, r = render(count)
    while (count > 1 && r.text.length > CHARACTER_LIMIT) { count = Math.ceil(count / 2); r = render(count) }
    return response_format === 'json' ? ok(r.text, r.page) : ok(r.text)
  })

  server.registerTool('peerpad_search', {
    title: 'Search workspace',
    description: 'Find pages and blocks containing some text (case-insensitive). Returns page ids, block ids and snippets. Example: query "launch checklist".',
    inputSchema: z.strictObject({
      query: z.string().min(2).max(200).describe('Text to look for in page titles and block text'),
      limit: z.number().int().min(1).max(100).default(30).describe('Maximum matches to return'),
      offset: z.number().int().min(0).default(0).describe('Matches to skip, for pagination'),
      response_format: ResponseFormat,
    }),
    annotations: RO,
  }, async ({ query, limit, offset, response_format }) => {
    await ready()
    const q = query.toLowerCase()
    const hits = []
    for (const id of pages.keys()) {
      if (title(id).toLowerCase().includes(q)) hits.push({ page_id: id, page_title: title(id), block_id: null, snippet: title(id) })
      for (const b of pages.get(id).get('blocks')?.toArray() || []) {
        const t = b.get('text')?.toString() || ''
        const at = t.toLowerCase().indexOf(q)
        if (at >= 0) hits.push({ page_id: id, page_title: title(id), block_id: b.get('id'), snippet: (at > 40 ? '…' : '') + t.slice(Math.max(0, at - 40), at + q.length + 80) })
      }
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
    description: 'Create a new page, optionally inside another page, with content written in markdown (headings, - lists, 1. lists, - [ ] to-dos, > quotes, > 💡 callouts, ``` code, ---). Returns the new page id. Teammates see it appear live.',
    inputSchema: z.strictObject({
      title: z.string().min(1).max(300).describe('Page title'),
      content_markdown: z.string().max(200000).default('').describe('Page body in markdown; empty for a blank page'),
      parent_id: z.string().optional().describe('Put the page inside this page (page id); omit for a top-level page'),
      icon: z.string().max(8).default('').describe('Optional emoji icon, e.g. "📝"'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ title: t, content_markdown, parent_id, icon: ic }) => {
    if (parent_id) { await ready(); getPage(parent_id) }
    const specs = parseMarkdown(content_markdown)
    const id = uid()
    await write(() => {
      const p = new Y.Map()
      p.set('title', new Y.Text(t)); p.set('icon', ic); p.set('parent', parent_id || null)
      p.set('order', Date.now()); p.set('created', Date.now())
      const arr = new Y.Array()
      arr.push((specs.length ? specs : [{}]).map(makeBlock))
      p.set('blocks', arr)
      pages.set(id, p)
    }, id)
    return ok(`Created page "${t}" (id: ${id}) with ${specs.length} block(s).`)
  })

  server.registerTool('peerpad_add_content', {
    title: 'Add content to page',
    description: 'Insert markdown content into an existing page as new blocks: at the end (default), at the start, or right after a given block. Use this to append notes or tasks without touching existing text.',
    inputSchema: z.strictObject({
      page_id: PageId,
      content_markdown: z.string().min(1).max(200000).describe('Markdown to insert'),
      position: z.enum(['end', 'start']).default('end').describe("Where to insert when after_block_id is not given"),
      after_block_id: z.string().optional().describe('Insert right after this block (id from peerpad_read_page)'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ page_id, content_markdown, position, after_block_id }) => {
    await ready()
    const p = getPage(page_id)
    const specs = parseMarkdown(content_markdown)
    if (!specs.length) throw new Error('The markdown contained no content to insert.')
    const blocks = p.get('blocks')
    const at = after_block_id ? findBlock(p, after_block_id).i + 1 : position === 'start' ? 0 : blocks.length
    const made = specs.map(makeBlock)
    await write(() => blocks.insert(at, made), page_id)
    return ok(`Inserted ${made.length} block(s) into "${title(page_id)}" at position ${at}. New block ids: ${made.map((b) => b.get('id')).join(', ')}`)
  })

  server.registerTool('peerpad_update_block', {
    title: 'Update block',
    description: 'Change one block: its text, type, checked state (to-dos) or indent. Only the fields you pass change. Text edits are merged character by character, so teammates typing elsewhere are not overwritten. Example: check off a to-do with checked=true.',
    inputSchema: z.strictObject({
      page_id: PageId,
      block_id: z.string().min(1).describe('Block id from peerpad_read_page'),
      text: z.string().max(100000).optional().describe('New full text of the block (plain text, no markdown prefix)'),
      type: BlockType.optional(),
      checked: z.boolean().optional().describe('For to-do blocks'),
      indent: z.number().int().min(0).max(6).optional().describe('Nesting level for list items'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ page_id, block_id, text, type, checked, indent }) => {
    await ready()
    const { b } = findBlock(getPage(page_id), block_id)
    await write(() => {
      if (text !== undefined) applyDiff(b.get('text'), type === 'divider' ? '' : text)
      if (type) b.set('type', type)
      if (checked !== undefined) b.set('checked', checked)
      if (indent !== undefined) b.set('indent', indent)
    }, page_id)
    return ok(`Updated block ${block_id}: ${blockMd(b, 1)}`)
  })

  server.registerTool('peerpad_delete_block', {
    title: 'Delete block',
    description: 'Delete one block from a page. Teammates can undo it with Ctrl+Z only on their own edits, so confirm with the user before deleting content they wrote.',
    inputSchema: z.strictObject({ page_id: PageId, block_id: z.string().min(1).describe('Block id from peerpad_read_page') }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ page_id, block_id }) => {
    await ready()
    const p = getPage(page_id)
    const { i, b } = findBlock(p, block_id)
    const was = blockMd(b, 1)
    await write(() => { p.get('blocks').delete(i, 1); if (!p.get('blocks').length) p.get('blocks').push([makeBlock()]) }, page_id)
    return ok(`Deleted block ${block_id} (was: ${was.slice(0, 120)})`)
  })

  server.registerTool('peerpad_replace_page_content', {
    title: 'Replace page content',
    description: 'Replace ALL blocks of a page with new markdown content (the title stays). Use for rewrites, reformatting or summaries in place. For small changes prefer peerpad_update_block or peerpad_add_content, which keep teammates\' concurrent edits.',
    inputSchema: z.strictObject({ page_id: PageId, content_markdown: z.string().max(200000).describe('The new page body in markdown') }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ page_id, content_markdown }) => {
    await ready()
    const p = getPage(page_id)
    const specs = parseMarkdown(content_markdown)
    await write(() => {
      const blocks = p.get('blocks')
      blocks.delete(0, blocks.length)
      blocks.push((specs.length ? specs : [{}]).map(makeBlock))
    }, page_id)
    return ok(`Replaced the content of "${title(page_id)}" with ${specs.length} block(s).`)
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
  }, async ({ page_id, title: t, icon: ic, parent_id }) => {
    await ready()
    const p = getPage(page_id)
    if (parent_id) {
      getPage(parent_id)
      let a = parent_id, g = 0
      while (a && g++ < 50) { if (a === page_id) throw new Error('A page cannot be moved inside itself or one of its own sub-pages.'); a = parentOf(a) }
    }
    await write(() => {
      if (t !== undefined) applyDiff(p.get('title'), t)
      if (ic !== undefined) p.set('icon', ic)
      if (parent_id !== undefined) { p.set('parent', parent_id); p.set('order', Date.now()) }
    }, page_id)
    return ok(`Updated page ${page_id}: "${title(page_id)}"${parentOf(page_id) ? ' inside "' + title(parentOf(page_id)) + '"' : ' (top level)'}`)
  })

  server.registerTool('peerpad_delete_page', {
    title: 'Delete page',
    description: 'Delete a page and every page inside it, for everyone in the workspace. Confirm with the user first.',
    inputSchema: z.strictObject({ page_id: PageId }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ page_id }) => {
    await ready()
    getPage(page_id)
    const all = [page_id]
    for (let i = 0; i < all.length; i++) all.push(...childrenOf(all[i]))
    const names = all.map(title)
    await write(() => all.forEach((id) => pages.delete(id)))
    return ok(`Deleted ${all.length} page(s): ${names.join(', ')}`)
  })

  return server
}

/* ------------------------------------------------------------------ transport */
if (process.env.TRANSPORT === 'http') {
  const { createMcpExpressApp } = await import('@modelcontextprotocol/express')
  const { toNodeHandler } = await import('@modelcontextprotocol/node')
  const token = process.env.MCP_TOKEN
  if (!token || token.length < 24) { log('Set MCP_TOKEN to a random secret of at least 24 characters (e.g. `openssl rand -hex 24`).'); process.exit(1) }
  const host = process.env.HOST || '127.0.0.1'
  const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(',').map((s) => s.trim()).filter(Boolean)
  const app = createMcpExpressApp(allowedHosts?.length ? { host, allowedHosts } : { host })
  const nodeHandler = toNodeHandler(createMcpHandler(createServer))
  const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y) }
  // Accept the token as a Bearer header, or as the last path segment (for clients that only take a URL).
  const auth = (req, res, next) => {
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (same(bearer, token) || same(req.params.token || '', token)) return next()
    res.status(401).json({ error: 'Missing or wrong MCP token.' })
  }
  app.all('/mcp', auth, (req, res) => void nodeHandler(req, res, req.body))
  app.all('/mcp/:token', auth, (req, res) => void nodeHandler(req, res, req.body))
  const port = Number(process.env.PORT || 3333)
  app.listen(port, host, () => log(`listening on http://${host}:${port}/mcp`))
} else {
  serveStdio(createServer)
  log('running on stdio')
}
