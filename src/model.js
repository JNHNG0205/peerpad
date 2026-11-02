// Shared document model: block structure, Markdown import/export.
// Used by the browser app and the MCP server (Node), so both read and write the same format.
//
// Block (Y.Map): id, type, text (Y.Text), checked, indent, and per type:
//   pagelink: ref            image: asset | url | data (Uint8Array), mime, width (25-100)
//   table: rows (Y.Array<Y.Array<Y.Text>>), first row = header
//   chart: rows (same as table: first column labels, other columns series), chart ('bar'|'line')
//   toc: (nothing; lists the page's headings)
import * as Y from 'yjs'

export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4)
export const TEXT_TYPES = ['p', 'h1', 'h2', 'h3', 'bullet', 'number', 'todo', 'quote', 'callout', 'code']
export const SPECIAL_TYPES = ['divider', 'pagelink', 'image', 'table', 'chart', 'toc']

export function rowsToY(rows) {
  const a = new Y.Array()
  a.push(rows.map((r) => {
    const ra = new Y.Array()
    ra.push(r.map((c) => new Y.Text(String(c ?? ''))))
    return ra
  }))
  return a
}
export const rowsOf = (bm) => bm.get('rows')?.toArray().map((r) => r.toArray().map((t) => t.toString())) || []

export function makeBlock({ type = 'p', text = '', checked = false, indent = 0, ref = null, rows = null, chart = null, url = null, asset = null, mime = null, width = null, data = null } = {}) {
  const m = new Y.Map()
  m.set('id', uid())
  m.set('type', type)
  m.set('text', new Y.Text(text))
  m.set('checked', !!checked)
  m.set('indent', indent)
  if (ref) m.set('ref', ref)
  if (type === 'table' || type === 'chart') m.set('rows', rowsToY(rows?.length ? rows : defaultRows(type)))
  if (type === 'chart') m.set('chart', chart === 'line' ? 'line' : 'bar')
  if (url) m.set('url', url)
  if (asset) m.set('asset', asset)
  if (mime) m.set('mime', mime)
  if (width) m.set('width', width)
  if (data) m.set('data', data)
  return m
}
export function defaultRows(type) {
  return type === 'chart'
    ? [['Month', 'Value'], ['Jan', '12'], ['Feb', '19'], ['Mar', '15'], ['Apr', '24']]
    : [['', '', ''], ['', '', ''], ['', '', '']]
}
/** Plain description of a block, enough to clone it. */
export function specOf(bm) {
  const s = { type: bm.get('type'), text: bm.get('text')?.toString() ?? '', checked: bm.get('checked'), indent: bm.get('indent') || 0 }
  for (const k of ['ref', 'chart', 'url', 'asset', 'mime', 'width', 'data']) if (bm.get(k) != null) s[k] = bm.get(k)
  if (bm.get('rows')) s.rows = rowsOf(bm)
  return s
}

/* ---------------- Markdown -> block specs ---------------- */
const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|').replace(/<br\s*\/?>/gi, '\n'))
const isSepRow = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)

export function parseMarkdown(md) {
  const out = []
  const lines = String(md).replace(/\r/g, '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    // fenced code / chart
    const fence = l.match(/^\s*```\s*(\w*)/)
    if (fence) {
      const body = []
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i])
      if (fence[1] === 'chart') out.push(parseChart(body.join('\n')))
      else out.push({ type: 'code', text: body.join('\n') })
      continue
    }
    // table: consecutive lines starting with |
    if (/^\s*\|/.test(l)) {
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) { if (!isSepRow(lines[i])) rows.push(splitRow(lines[i])); i++ }
      i--
      const cols = Math.max(...rows.map((r) => r.length))
      out.push({ type: 'table', rows: rows.map((r) => [...r, ...Array(cols - r.length).fill('')]) })
      continue
    }
    if (!l.trim()) continue
    const indent = Math.min(6, Math.floor(l.match(/^\s*/)[0].replace(/\t/g, '  ').length / 2))
    const t = l.trim()
    let m
    if (/^(---|\*\*\*|___)$/.test(t)) out.push({ type: 'divider' })
    else if (/^\[(toc|TOC)\]$|^\[\[toc\]\]$/i.test(t)) out.push({ type: 'toc' })
    else if ((m = t.match(/^!\[([^\]]*)\]\((\S+?)(?:\s+"[^"]*")?\)$/))) {
      const src = m[2]
      if (src.startsWith('peerpad-asset:')) out.push({ type: 'image', text: m[1], asset: src.slice(14) })
      else if (/^(https?:|data:image\/)/i.test(src)) out.push({ type: 'image', text: m[1], url: src })
      else out.push({ type: 'p', text: t })
    }
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
/** ```chart body: JSON {"type":"bar","title":"…","rows":[["Month","TVL"],["Oct",27]]} or CSV lines. */
function parseChart(body) {
  try {
    const j = JSON.parse(body)
    return { type: 'chart', chart: j.type, text: j.title || '', rows: (j.rows || []).map((r) => r.map(String)) }
  } catch {
    const rows = body.split('\n').filter((l) => l.trim()).map((l) => l.split(',').map((c) => c.trim()))
    return { type: 'chart', chart: 'bar', rows }
  }
}

/* ---------------- blocks -> Markdown ---------------- */
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, '<br>')
export function tableToMarkdown(rows) {
  if (!rows.length) return ''
  const cols = Math.max(...rows.map((r) => r.length))
  const pad = (r) => [...r, ...Array(cols - r.length).fill('')]
  const [head, ...rest] = rows.map(pad)
  return [`| ${head.map(cell).join(' | ')} |`, `|${' --- |'.repeat(cols)}`, ...rest.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n')
}
/** n = number for numbered lists, titleOf(pageId) for sub-page links. */
export function blockToMarkdown(b, n = 1, titleOf = () => 'Untitled') {
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
    case 'toc': return '[TOC]'
    case 'pagelink': return `[${titleOf(b.get('ref'))}](peerpad-page:${b.get('ref')})`
    case 'image': return `![${t.replace(/[\[\]]/g, '')}](${b.get('url') || (b.get('asset') ? 'peerpad-asset:' + b.get('asset') : 'embedded-image')})`
    case 'table': return tableToMarkdown(rowsOf(b))
    case 'chart': return '```chart\n' + JSON.stringify({ type: b.get('chart') || 'bar', title: t || undefined, rows: rowsOf(b) }) + '\n```'
    default: return `${pad}${t}`
  }
}
/** Numbers for numbered lists, per indent level, over a whole page. */
export function listNumbers(blocks) {
  const nums = []
  const stack = []
  for (const b of blocks) {
    const ind = b.get('indent') || 0
    stack.length = ind + 1
    stack[ind] = b.get('type') === 'number' ? (stack[ind] || 0) + 1 : 0
    nums.push(stack[ind])
  }
  return nums
}
export function blocksToMarkdown(blocks, titleOf) {
  const nums = listNumbers(blocks)
  return blocks.map((b, i) => blockToMarkdown(b, nums[i], titleOf)).join('\n')
}

/* ---------------- numbers for charts ---------------- */
/** "$35.9B" -> 35.9e9, "1,234" -> 1234, "12%" -> 12. NaN if not a number. */
export function parseNumber(s) {
  const m = String(s).replace(/[,\s]/g, '').match(/^[^\d\-.]*(-?\d*\.?\d+)([kKmMbBtT]?)/)
  if (!m) return NaN
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2].toLowerCase()] || 1
  return parseFloat(m[1]) * mult
}
