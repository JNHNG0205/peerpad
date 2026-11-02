import { BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core'
import { ChartBlock } from './Chart'
import { TocBlock } from './Toc'
import { CalloutBlock } from './Callout'

/** The editor schema: BlockNote's blocks plus charts, table of contents and callouts. */
export const schema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, chart: ChartBlock(), toc: TocBlock(), callout: CalloutBlock() },
})
export type Schema = typeof schema
