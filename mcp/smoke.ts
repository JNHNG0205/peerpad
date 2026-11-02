// Self-check: starts the MCP server over stdio, calls every tool, exits non-zero on failure.
// Usage: PEERPAD_INVITE="<edit link>" node mcp/smoke.ts   (creates and deletes a test page; KEEP=1 keeps it)
import { strict as assert } from 'node:assert'
import { Client } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const client = new Client({ name: 'peerpad-smoke', version: '1.0.0' })
await client.connect(new StdioClientTransport({
  command: 'node',
  args: [new URL('./peerpad-mcp.ts', import.meta.url).pathname],
  env: { ...getDefaultEnvironment(), PEERPAD_INVITE: process.env.PEERPAD_INVITE ?? '', PEERPAD_AI_NAME: 'Smoke test' },
}))
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args })
  assert.ok(!r.isError, `${name} failed: ${r.content?.[0]?.text}`)
  return r
}
const text = (r: any): string => r.content[0].text

const { tools } = await client.listTools()
console.error('tools:', tools.map((t) => t.name).join(', '))
assert.equal(tools.length, 11)
assert.match(text(await call('peerpad_list_workspaces')), /can edit/)
console.error(text(await call('peerpad_list_pages')).split('\n').slice(0, 4).join('\n'))

const md = [
  '[TOC]', '## Plan', '> 💡 Remember the **deadline**', '- [ ] first task', '- [x] done task', '1. step one',
  '| Track | Fit |', '| --- | --- |', '| Privacy | Main |',
  '```chart', JSON.stringify({ type: 'bar', title: 'TVL', rows: [['Month', 'USD M'], ['Oct', '27'], ['Nov', '48']] }), '```',
  '```js', 'console.log(1)', '```',
].join('\n')
const created = text(await call('peerpad_create_page', { title: 'MCP smoke test', icon: '🤖', content_markdown: md }))
const pageId = created.match(/id: (\w+)/)![1]
const json: any = (await call('peerpad_read_page', { page_id: pageId, response_format: 'json' })).structuredContent
const types = json.blocks.map((b: any) => b.type)
console.error('types:', types.join(', '))
for (const t of ['toc', 'heading', 'callout', 'checkListItem', 'numberedListItem', 'table', 'chart', 'codeBlock']) assert.ok(types.includes(t), 'missing ' + t)
const todo = json.blocks.find((b: any) => b.type === 'checkListItem')
const chart = json.blocks.find((b: any) => b.type === 'chart')
const heading = json.blocks.find((b: any) => b.type === 'heading')
await call('peerpad_update_block', { page_id: pageId, block_id: todo.id, checked: true })
await call('peerpad_update_block', { page_id: pageId, block_id: chart.id, chart_type: 'line', chart_rows: [['Month', 'USD M'], ['Oct', '27'], ['Nov', '48'], ['Dec', '60']] })
await call('peerpad_update_block', { page_id: pageId, block_id: heading.id, markdown: '## Plan (edited by AI)' })
await call('peerpad_add_content', { page_id: pageId, content_markdown: '- added after heading', after_block_id: heading.id })
const read = text(await call('peerpad_read_page', { page_id: pageId }))
console.error(read)
assert.match(read, /\[x\] first task/)
assert.match(read, /Plan \(edited by AI\)/)
assert.match(read, /"type":"line"/)
assert.match(read, /added after heading/)
assert.ok(read.includes(`[${heading.id}]`), 'heading kept its id')
assert.match(text(await call('peerpad_search', { query: 'deadline' })), /MCP smoke test/)
await call('peerpad_update_page', { page_id: pageId, title: 'MCP smoke test (renamed)' })
const bad: any = await client.callTool({ name: 'peerpad_read_page', arguments: { page_id: 'nope' } })
assert.equal(bad.isError, true)
if (!process.env.KEEP) await call('peerpad_delete_page', { page_id: pageId })
await client.close()
console.error('Smoke test passed', process.env.KEEP ? `(kept page ${pageId})` : '')
