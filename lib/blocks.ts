// Custom block definitions shared by the web editor (React renderers) and the MCP server (Node).
// The type names and props decide how blocks are stored in the shared document, so both sides
// must use these exact configs.
import { BlockNoteSchema, defaultBlockSpecs, createBlockSpec } from '@blocknote/core'

export const DEFAULT_CHART_ROWS: string[][] = [['Month', 'Value'], ['Jan', '12'], ['Feb', '19'], ['Mar', '15'], ['Apr', '24']]

export const chartConfig = {
  type: 'chart',
  propSchema: {
    chartType: { default: 'bar' as 'bar' | 'line', values: ['bar', 'line'] as const },
    title: { default: '' },
    /** JSON string: rows of cells, first row = header (labels column, then one column per series) */
    data: { default: JSON.stringify(DEFAULT_CHART_ROWS) },
  },
  content: 'none',
} as const

export const tocConfig = { type: 'toc', propSchema: {}, content: 'none' } as const

export const calloutConfig = {
  type: 'callout',
  propSchema: { emoji: { default: '💡' } },
  content: 'inline',
} as const

export function parseRows(data: string | undefined): string[][] {
  try {
    const rows = JSON.parse(data || '[]')
    return Array.isArray(rows) ? rows.map((r: unknown[]) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [])) : []
  } catch {
    return []
  }
}

/** Schema with plain DOM renderers, for Node (MCP server) where React rendering is not needed. */
export function createServerSchema() {
  const div = () => ({ dom: globalThis.document.createElement('div') })
  const chart = createBlockSpec(chartConfig as any, { render: div })
  const toc = createBlockSpec(tocConfig as any, { render: div })
  const callout = createBlockSpec(calloutConfig as any, {
    render: () => {
      const dom = globalThis.document.createElement('div')
      const contentDOM = globalThis.document.createElement('div')
      dom.append(contentDOM)
      return { dom, contentDOM }
    },
  })
  return BlockNoteSchema.create({ blockSpecs: { ...defaultBlockSpecs, chart: chart(), toc: toc(), callout: callout() } })
}
