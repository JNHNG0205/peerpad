'use client'
import { useMemo } from 'react'
import { useCreateBlockNote, SuggestionMenuController, getDefaultReactSlashMenuItems } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { filterSuggestionItems, insertOrUpdateBlockForSlashMenu } from '@blocknote/core'
import { CollaborationExtension } from '@blocknote/core/yjs'
import { BarChart3, ListTree, Lightbulb } from 'lucide-react'
import { schema } from './blocks/schema'
import { pageFragment } from '@/lib/pages.ts'
import type * as Y from 'yjs'
import { uploadFile, resolveFileUrl } from '@/lib/images.ts'
import type { Session, Me } from '@/lib/session.ts'

function customSlashItems(editor: any) {
  return [
    {
      title: 'Chart', subtext: 'Bar or line chart from a data table', group: 'Advanced', aliases: ['graph', 'bar', 'line', 'plot'],
      icon: <BarChart3 size={18} />,
      onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'chart' } as any),
    },
    {
      title: 'Table of contents', subtext: 'Links to the headings on this page', group: 'Advanced', aliases: ['toc', 'contents', 'outline'],
      icon: <ListTree size={18} />,
      onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'toc' } as any),
    },
    {
      title: 'Callout', subtext: 'Highlighted note with an icon', group: 'Basic blocks', aliases: ['note', 'tip', 'info', 'warning'],
      icon: <Lightbulb size={18} />,
      onItemClick: () => insertOrUpdateBlockForSlashMenu(editor, { type: 'callout' } as any),
    },
  ]
}

/** Collaborative editor for one page (its own document). initialContent is for read-only previews without collaboration. */
export default function Editor({ session, pageDoc, pageId, me, readOnly, theme, initialContent }: {
  session: Session; pageDoc?: Y.Doc; pageId: string; me: Me; readOnly: boolean; theme: 'light' | 'dark'; initialContent?: any[]
}) {
  const fragment = useMemo(() => (pageDoc ? pageFragment(pageDoc) : null), [pageDoc])
  const assets = session.net.assets
  const editor = useCreateBlockNote(
    {
      schema,
      ...(initialContent || !fragment
        ? { initialContent: initialContent?.length ? initialContent : undefined }
        : { extensions: [CollaborationExtension({ fragment, user: { name: me.name, color: me.color }, provider: { awareness: session.net.awareness as any }, showCursorLabels: 'activity' })] }),
      uploadFile: readOnly ? undefined : (file: File) => uploadFile(file, assets),
      resolveFileUrl: (url: string) => resolveFileUrl(url, assets),
    } as any,
    [pageId, initialContent ? 'preview' : 'live'],
  )
  return (
    <BlockNoteView editor={editor as any} theme={theme} editable={!readOnly} slashMenu={false} className="-mx-[54px] max-[820px]:-mx-4">
      <SuggestionMenuController
        triggerCharacter="/"
        getItems={async (query: string) => filterSuggestionItems([...getDefaultReactSlashMenuItems(editor as any), ...customSlashItems(editor)], query)}
      />
    </BlockNoteView>
  )
}
