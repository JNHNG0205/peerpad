// Self-check: starts the MCP server over stdio, calls every tool, exits non-zero on failure.
// Usage: PEERPAD_INVITE="<invite link>" node mcp/smoke.js
// It creates and then deletes a page called "MCP smoke test".
import { strict as assert } from 'node:assert'
import { Client } from '@modelcontextprotocol/client'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const client = new Client({ name: 'peerpad-smoke', version: '1.0.0' })
await client.connect(new StdioClientTransport({
  command: 'node',
  args: [new URL('./peerpad-mcp.js', import.meta.url).pathname],
  env: { ...getDefaultEnvironment(), PEERPAD_INVITE: process.env.PEERPAD_INVITE ?? '' },
}))
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  assert.ok(!r.isError, `${name} failed: ${r.content?.[0]?.text}`)
  return r
}
const text = (r) => r.content[0].text

const { tools } = await client.listTools()
console.error('tools:', tools.map((t) => t.name).join(', '))
assert.equal(tools.length, 10)

console.error(text(await call('peerpad_list_pages')).split('\n').slice(0, 4).join('\n'))
const created = text(await call('peerpad_create_page', {
  title: 'MCP smoke test', icon: '🤖',
  content_markdown: '## Plan\n- [ ] first task\n- [x] done task\n1. step one\n```\nconsole.log(1)\n```\n> 💡 tip',
}))
const pageId = created.match(/id: (\w+)/)[1]
const read = await call('peerpad_read_page', { page_id: pageId, response_format: 'json' })
const blocks = read.structuredContent.blocks
assert.deepEqual(blocks.map((b) => b.type), ['h2', 'todo', 'todo', 'number', 'code', 'callout'])
await call('peerpad_update_block', { page_id: pageId, block_id: blocks[1].id, checked: true, text: 'first task (checked by AI)' })
await call('peerpad_add_content', { page_id: pageId, content_markdown: '- added after heading', after_block_id: blocks[0].id })
const md = text(await call('peerpad_read_page', { page_id: pageId }))
console.error(md)
assert.match(md, /- \[x\] first task \(checked by AI\)/)
assert.match(md, /\] - added after heading/)
assert.match(text(await call('peerpad_search', { query: 'checked by AI' })), /MCP smoke test/)
await call('peerpad_update_page', { page_id: pageId, title: 'MCP smoke test (renamed)' })
const bad = await client.callTool({ name: 'peerpad_read_page', arguments: { page_id: 'nope' } })
assert.equal(bad.isError, true)
if (!process.env.KEEP) await call('peerpad_delete_page', { page_id: pageId })
await client.close()
console.error('Smoke test passed', process.env.KEEP ? `(kept page ${pageId})` : '')
