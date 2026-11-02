// Markdown <-> blocks, including PeerPad's custom blocks:
//   charts:  ```chart {"type":"bar","title":"…","rows":[["Month","TVL"],["Oct","27"]]} ```
//   table of contents: [TOC]
//   callouts: > 💡 text
// Works with the browser editor and with ServerBlockNoteEditor (both have these two methods).
import { parseRows } from './blocks.ts'

export type MarkdownEditor = {
  tryParseMarkdownToBlocks(md: string): Promise<any[]>
  blocksToMarkdownLossy(blocks: any[]): Promise<string>
}

const CALLOUT_RE = /^>\s?(\p{Extended_Pictographic}️?)\s+(.*)$/u

export async function markdownToBlocks(editor: MarkdownEditor, md: string): Promise<any[]> {
  const lines = String(md).replace(/\r/g, '').split('\n')
  const out: any[] = []
  let normal: string[] = []
  const flush = async () => {
    const text = normal.join('\n').trim()
    normal = []
    if (text) out.push(...(await editor.tryParseMarkdownToBlocks(text)))
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const fence = l.match(/^\s*```\s*([\w-]*)/)
    if (fence) {
      const body: string[] = []
      let j = i + 1
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) body.push(lines[j++])
      if (fence[1] === 'chart') {
        await flush()
        out.push(chartFromFence(body.join('\n')))
      } else {
        normal.push(...lines.slice(i, Math.min(j + 1, lines.length)))
      }
      i = j
      continue
    }
    if (/^\s*\[(toc|TOC)\]\s*$|^\s*\[\[toc\]\]\s*$/i.test(l)) { await flush(); out.push({ type: 'toc' }); continue }
    const c = l.match(CALLOUT_RE)
    if (c) {
      await flush()
      const inner = await editor.tryParseMarkdownToBlocks(c[2])
      out.push({ type: 'callout', props: { emoji: c[1] }, content: inner[0]?.content ?? c[2] })
      continue
    }
    normal.push(l)
  }
  await flush()
  return out
}

function chartFromFence(body: string): any {
  let j: any
  try { j = JSON.parse(body) } catch {
    const rows = body.split('\n').filter((l) => l.trim()).map((l) => l.split(',').map((x) => x.trim()))
    j = { type: 'bar', rows }
  }
  const rows = (j.rows || []).map((r: unknown[]) => r.map((x) => String(x ?? '')))
  return { type: 'chart', props: { chartType: j.type === 'line' ? 'line' : 'bar', title: j.title || '', data: JSON.stringify(rows) } }
}

export async function blocksToMarkdown(editor: MarkdownEditor, blocks: any[]): Promise<string> {
  const out: string[] = []
  let run: any[] = []
  const flush = async () => {
    if (run.length) out.push((await editor.blocksToMarkdownLossy(run)).trim())
    run = []
  }
  for (const b of blocks) {
    if (b.type === 'chart') {
      await flush()
      out.push('```chart\n' + JSON.stringify({ type: b.props?.chartType || 'bar', title: b.props?.title || undefined, rows: parseRows(b.props?.data) }) + '\n```')
    } else if (b.type === 'toc') {
      await flush()
      out.push('[TOC]')
    } else if (b.type === 'callout') {
      await flush()
      const inner = (await editor.blocksToMarkdownLossy([{ type: 'paragraph', content: b.content }])).trim()
      out.push(`> ${b.props?.emoji || '💡'} ${inner.replace(/\n+/g, ' ')}`)
    } else {
      run.push(b)
    }
  }
  await flush()
  return out.filter(Boolean).join('\n\n') + '\n'
}

/** Plain text of a block's inline content (for search, titles, table of contents). */
export function inlineText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    const c = content as any
    if (c?.type === 'tableContent') return (c.rows || []).map((r: any) => r.cells.map((cell: any) => inlineText(cell?.content ?? cell)).join(' | ')).join('\n')
    return ''
  }
  return content.map((n: any) => (n.type === 'text' ? n.text : n.type === 'link' ? inlineText(n.content) : '')).join('')
}
