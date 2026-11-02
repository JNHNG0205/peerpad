'use client'
import { useState } from 'react'
import { createReactBlockSpec, useEditorChange } from '@blocknote/react'
import { tocConfig } from '@/lib/blocks.ts'
import { inlineText } from '@/lib/markdown.ts'

type Heading = { id: string; level: number; text: string }
function headingsOf(blocks: any[], out: Heading[] = []): Heading[] {
  for (const b of blocks) {
    if (b.type === 'heading') out.push({ id: b.id, level: b.props.level || 1, text: inlineText(b.content) })
    if (b.children?.length) headingsOf(b.children, out)
  }
  return out
}

export const TocBlock = createReactBlockSpec(tocConfig as any, {
  render: ({ editor }: any) => {
    const [heads, setHeads] = useState<Heading[]>(() => headingsOf(editor.document))
    useEditorChange(() => setHeads(headingsOf(editor.document)), editor)
    const go = (id: string) => {
      const el = document.querySelector(`[data-id="${id}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el?.animate?.([{ background: 'var(--accent-soft)' }, { background: 'transparent' }], { duration: 1400, easing: 'ease-out' })
    }
    return (
      <nav aria-label="Table of contents" contentEditable={false} className="my-1 w-full border-l-2 border-line py-1 pl-4">
        {heads.length === 0 && <p className="text-sm text-faint">Headings on this page will be listed here.</p>}
        {heads.map((h) => (
          <button key={h.id} onClick={() => go(h.id)} style={{ paddingLeft: (h.level - 1) * 16 }}
            className="block w-full truncate py-0.5 text-left text-sm text-muted underline decoration-line underline-offset-4 transition hover:text-fg hover:decoration-fg">
            {h.text || 'Untitled heading'}
          </button>
        ))}
      </nav>
    )
  },
})
