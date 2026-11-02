'use client'
import { createReactBlockSpec } from '@blocknote/react'
import { calloutConfig } from '@/lib/blocks.ts'

const EMOJIS = ['💡', '⚠️', '✅', '📌', '🔥', '❗', 'ℹ️', '🎯']

export const CalloutBlock = createReactBlockSpec(calloutConfig as any, {
  render: ({ block, editor, contentRef }: any) => (
    <div className="my-1 flex w-full items-start gap-3 rounded-xl bg-accent-soft/70 px-4 py-3">
      <button
        contentEditable={false}
        title={editor.isEditable ? 'Change icon' : undefined}
        disabled={!editor.isEditable}
        onClick={() => {
          const i = EMOJIS.indexOf(block.props.emoji)
          editor.updateBlock(block, { props: { emoji: EMOJIS[(i + 1) % EMOJIS.length] } })
        }}
        className="mt-0.5 select-none text-lg leading-none transition-transform enabled:hover:scale-110"
      >
        {block.props.emoji}
      </button>
      <div ref={contentRef} className="min-w-0 flex-1" />
    </div>
  ),
})
