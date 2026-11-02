'use client'
// Converts Markdown and older page formats into page content, using an editor that is never shown.
import { BlockNoteEditor } from '@blocknote/core'
import { blocksToYXmlFragment, yXmlFragmentToBlocks } from '@blocknote/core/yjs'
import type * as Y from 'yjs'
import { schema } from './blocks/schema'
import { markdownToBlocks, blocksToMarkdown } from '@/lib/markdown.ts'
import { fragmentOf, pageFragment, legacyMarkdown, contentSource, PAGE_VERSION } from '@/lib/pages.ts'
import type { Session } from '@/lib/session.ts'

let conv: any = null
export const converter = (): any => (conv ??= BlockNoteEditor.create({ schema }))

/** Fill an empty page with Markdown content. */
export async function writeMarkdown(s: Session, pageId: string, md: string) {
  const ed = converter()
  const blocks = await markdownToBlocks(ed, md)
  if (!blocks.length) return
  await s.net.withPage(pageId, (doc) => {
    const frag = pageFragment(doc)
    if (!frag.length) doc.transact(() => blocksToYXmlFragment(ed, blocks, frag), 'local')
  })
}

/** Blocks of a page in an older format (shown read-only until an editor converts it). */
export async function olderFormatBlocks(s: Session, pageId: string): Promise<any[]> {
  const page = s.pages.get(pageId)
  const src = contentSource(s.doc, page, pageId)
  if (src === 'root') return yXmlFragmentToBlocks(converter(), fragmentOf(s.doc, pageId))
  if (src === 'legacy') return markdownToBlocks(converter(), legacyMarkdown(s.pages, page!))
  return []
}

/** Current blocks of any page, whatever its format. */
async function pageBlocks(s: Session, pageId: string): Promise<any[]> {
  if (contentSource(s.doc, s.pages.get(pageId), pageId) !== 'page') return olderFormatBlocks(s, pageId)
  return s.net.withPage(pageId, (doc) => yXmlFragmentToBlocks(converter(), pageFragment(doc)))
}
export async function pageMarkdown(s: Session, pageId: string): Promise<string> {
  return blocksToMarkdown(converter(), await pageBlocks(s, pageId))
}

/** Plain text of a page from this browser's copy (for search). */
export async function pageTextLocal(s: Session, pageId: string): Promise<string> {
  const strip = (f: Y.XmlFragment) => f.toString().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  if (contentSource(s.doc, s.pages.get(pageId), pageId) === 'root') return strip(fragmentOf(s.doc, pageId))
  const doc = await s.net.peekPage(pageId)
  return doc ? strip(pageFragment(doc)) : ''
}

/** Move a page from an older format into its own document (editors only). Keeps v1 data in place. */
export async function migratePage(s: Session, pageDoc: Y.Doc, pageId: string) {
  const page = s.pages.get(pageId)
  const src = contentSource(s.doc, page, pageId)
  if (!page || src === 'page') return
  const blocks = await olderFormatBlocks(s, pageId)
  const frag = pageFragment(pageDoc)
  if (!frag.length && blocks.length) pageDoc.transact(() => blocksToYXmlFragment(converter(), blocks, frag), 'local')
  s.doc.transact(() => {
    if (src === 'root') { const old = fragmentOf(s.doc, pageId); old.delete(0, old.length) } // shrinks the root document
    page.set('v', PAGE_VERSION)
  }, 'local')
}
