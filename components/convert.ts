'use client'
// Converts Markdown and first-version pages into page content, using an editor that is never shown.
import { BlockNoteEditor } from '@blocknote/core'
import { blocksToYXmlFragment, yXmlFragmentToBlocks } from '@blocknote/core/yjs'
import type * as Y from 'yjs'
import { schema } from './blocks/schema'
import { markdownToBlocks, blocksToMarkdown } from '@/lib/markdown.ts'
import { fragmentOf, legacyMarkdown, pagesOf } from '@/lib/pages.ts'

let conv: any = null
export const converter = (): any => (conv ??= BlockNoteEditor.create({ schema }))

/** Fill an empty page with Markdown content. */
export async function writeMarkdown(doc: Y.Doc, pageId: string, md: string) {
  const ed = converter()
  const blocks = await markdownToBlocks(ed, md)
  if (!blocks.length) return
  doc.transact(() => blocksToYXmlFragment(ed, blocks, fragmentOf(doc, pageId)), 'local')
}
export async function pageMarkdown(doc: Y.Doc, pageId: string): Promise<string> {
  const ed = converter()
  return blocksToMarkdown(ed, yXmlFragmentToBlocks(ed, fragmentOf(doc, pageId)))
}
/** Blocks for a first-version page (for read-only viewing before an editor converts it). */
export async function legacyBlocks(doc: Y.Doc, pageId: string): Promise<any[]> {
  const pages = pagesOf(doc)
  return markdownToBlocks(converter(), legacyMarkdown(pages, pages.get(pageId)!))
}
/** Convert a first-version page to the current format (keeps the old data too). */
export async function migratePage(doc: Y.Doc, pageId: string) {
  const pages = pagesOf(doc)
  const page = pages.get(pageId)
  if (!page || page.get('v') === 2 || fragmentOf(doc, pageId).length) return
  const blocks = await legacyBlocks(doc, pageId)
  doc.transact(() => {
    if (fragmentOf(doc, pageId).length) return // someone else converted it meanwhile
    if (blocks.length) blocksToYXmlFragment(converter(), blocks, fragmentOf(doc, pageId))
    page.set('v', 2)
  }, 'local')
}
