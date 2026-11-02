// Workspace structure, shared by the web app and the MCP server.
//   doc.getMap('meta')  name of the workspace
//   doc.getMap('pages') pageId -> Y.Map { title: Y.Text, icon, parent, order, created }
//   doc.getXmlFragment('page:<id>') the page's content (BlockNote document)
// Pages from the first version kept their content in a 'blocks' Y.Array; legacyMarkdown() converts it.
import * as Y from 'yjs'

export const uid = (): string => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4)
export const fragmentOf = (doc: Y.Doc, id: string): Y.XmlFragment => doc.getXmlFragment('page:' + id)

export function pagesOf(doc: Y.Doc): Y.Map<Y.Map<any>> {
  return doc.getMap('pages') as Y.Map<Y.Map<any>>
}
export const titleOf = (pages: Y.Map<Y.Map<any>>, id: string | null | undefined): string =>
  (id && pages.get(id)?.get('title')?.toString().trim()) || 'Untitled'
export const iconOf = (pages: Y.Map<Y.Map<any>>, id: string): string => pages.get(id)?.get('icon') || ''
export function parentOf(pages: Y.Map<Y.Map<any>>, id: string): string | null {
  const p = pages.get(id)?.get('parent')
  return p && pages.has(p) ? p : null
}
export function childrenOf(pages: Y.Map<Y.Map<any>>, parent: string | null): string[] {
  const out: string[] = []
  pages.forEach((_p, id) => { if (parentOf(pages, id) === parent) out.push(id) })
  return out.sort((a, b) => (pages.get(a)!.get('order') || 0) - (pages.get(b)!.get('order') || 0))
}
export function ancestorsOf(pages: Y.Map<Y.Map<any>>, id: string): string[] {
  const out: string[] = []
  let p = parentOf(pages, id), guard = 0
  while (p && guard++ < 50) { out.unshift(p); p = parentOf(pages, p) }
  return out
}
export function descendantsOf(pages: Y.Map<Y.Map<any>>, id: string): string[] {
  const all = [id]
  for (let i = 0; i < all.length; i++) all.push(...childrenOf(pages, all[i]))
  return all
}

/** Creates the page entry (content is written separately into fragmentOf(doc, id)). Call inside a transaction. */
export function addPage(pages: Y.Map<Y.Map<any>>, { id = uid(), parent = null, title = '', icon = '' }: { id?: string; parent?: string | null; title?: string; icon?: string } = {}): string {
  const p = new Y.Map<any>()
  p.set('title', new Y.Text(title))
  p.set('icon', icon)
  p.set('parent', parent)
  p.set('order', Date.now())
  p.set('created', Date.now())
  p.set('v', 2)
  pages.set(id, p)
  return id
}
/** Deletes pages and empties their content. Call inside a transaction. */
export function removePages(doc: Y.Doc, ids: string[]) {
  const pages = pagesOf(doc)
  for (const id of ids) {
    pages.delete(id)
    const f = fragmentOf(doc, id)
    if (f.length) f.delete(0, f.length)
  }
}
export function applyTitle(ytext: Y.Text, next: string) {
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

/* ---------------- first-version pages ---------------- */
export const isLegacy = (doc: Y.Doc, page: Y.Map<any> | undefined, id: string): boolean =>
  !!page && (page.get('blocks')?.length || 0) > 0 && fragmentOf(doc, id).length === 0

function b64(u8: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)))
  return btoa(s)
}
/** Markdown for a first-version page (its 'blocks' array), ready for markdownToBlocks(). */
export function legacyMarkdown(pages: Y.Map<Y.Map<any>>, page: Y.Map<any>): string {
  const blocks: Y.Map<any>[] = page.get('blocks')?.toArray() || []
  const out: string[] = []
  const stack: number[] = []
  for (const b of blocks) {
    const t: string = b.get('text')?.toString() ?? ''
    const ind = b.get('indent') || 0
    const pad = '   '.repeat(ind)
    stack.length = ind + 1
    stack[ind] = b.get('type') === 'number' ? (stack[ind] || 0) + 1 : 0
    const rows = (): string[][] => b.get('rows')?.toArray().map((r: Y.Array<Y.Text>) => r.toArray().map((x) => x.toString())) || []
    switch (b.get('type')) {
      case 'h1': out.push(`# ${t}`); break
      case 'h2': out.push(`## ${t}`); break
      case 'h3': out.push(`### ${t}`); break
      case 'bullet': out.push(`${pad}- ${t}`); break
      case 'number': out.push(`${pad}${stack[ind]}. ${t}`); break
      case 'todo': out.push(`${pad}- [${b.get('checked') ? 'x' : ' '}] ${t}`); break
      case 'quote': out.push(`> ${t}`); break
      case 'callout': out.push(`> 💡 ${t}`); break
      case 'code': out.push('```\n' + t + '\n```'); break
      case 'divider': out.push('---'); break
      case 'toc': out.push('[TOC]'); break
      case 'pagelink': out.push(`[${titleOf(pages, b.get('ref'))}](#p=${b.get('ref')})`); break
      case 'image': {
        const src = b.get('url') || (b.get('asset') ? `peerpad-asset:${b.get('asset')}?type=${b.get('mime') || 'image/webp'}` : b.get('data') ? `data:${b.get('mime') || 'image/png'};base64,${b64(b.get('data'))}` : '')
        if (src) out.push(`![${t.replace(/[[\]]/g, '')}](${src})`)
        break
      }
      case 'table': {
        const r = rows()
        if (r.length) {
          const cols = Math.max(...r.map((x) => x.length))
          const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
          const line = (x: string[]) => `| ${[...x, ...Array(cols - x.length).fill('')].map(cell).join(' | ')} |`
          out.push([line(r[0]), `|${' --- |'.repeat(cols)}`, ...r.slice(1).map(line)].join('\n'))
        }
        break
      }
      case 'chart': out.push('```chart\n' + JSON.stringify({ type: b.get('chart') || 'bar', title: t || undefined, rows: rows() }) + '\n```'); break
      default: out.push(t)
    }
  }
  // blank lines between blocks, but keep list items together
  return out.reduce((acc, line, i) => {
    const prevList = i > 0 && /^\s*([-*]|\d+\.)\s/.test(out[i - 1])
    const thisList = /^\s*([-*]|\d+\.)\s/.test(line)
    return acc + (i === 0 ? '' : prevList && thisList ? '\n' : '\n\n') + line
  }, '')
}
