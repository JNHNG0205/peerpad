import * as Y from 'yjs'
import { connect, loadLocal, generateWriteKeys, loadSigner } from './sync.js'
import { makeBlock, specOf, parseMarkdown, blocksToMarkdown, TEXT_TYPES } from './model.js'
import { renderInline, hasMarkup, wrapSelection, processImage, imageBlock, tableBlock, chartBlock, tocBlock } from './rich.js'
import './style.css'

/* ---------------- helpers ---------------- */
const $ = (s, el = document) => el.querySelector(s)
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (v === true) el.setAttribute(k, '')
    else if (v != null && v !== false) el.setAttribute(k, v)
  }
  for (const c of kids.flat()) if (c != null) el.append(c)
  return el
}
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4)
const randToken = (n = 12) =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch { return d } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
}
const COLORS = ['#e5484d', '#f76b15', '#d6a100', '#30a46c', '#12a594', '#0090ff', '#6e56cf', '#d6409f']
const ANIMALS = ['Otter', 'Heron', 'Lynx', 'Panda', 'Koala', 'Falcon', 'Badger', 'Gecko', 'Moose', 'Robin', 'Whale', 'Fox']
const EMOJI = '📄 📝 📌 📚 🗂️ 🗓️ ✅ 💡 🚀 🎯 🧪 🛠️ 📈 🧭 🏠 🌱 🔥 ⭐ 🎨 🧠 💬 📦 🔒 🧾 🗺️ 🍳 🎵 ✈️ 🐞 🤝'.split(' ')

/* ---------------- identity & workspace routing ---------------- */
const me = store.get('pp-me', null) || {
  name: ANIMALS[Math.floor(Math.random() * ANIMALS.length)] + ' ' + Math.floor(Math.random() * 90 + 10),
  color: COLORS[Math.floor(Math.random() * COLORS.length)],
}
store.set('pp-me', me)

const params = () => new URLSearchParams(location.hash.slice(1))
// pk/sk: public/private signing key. Edit links carry both, view links only pk.
let { ws, key, createdHere, srv, pk, sk } = (() => {
  const p = params()
  const recent = store.get('pp-recent', [])
  if (p.get('ws') && p.get('key')) {
    const known = recent.find((w) => w.ws === p.get('ws'))
    const pk = p.get('pk') || known?.pk || null
    // this browser keeps edit access if it had it before, even when opening a view link
    const sk = p.get('sk') || (known?.pk === pk ? known?.sk : null) || null
    return { ws: p.get('ws'), key: p.get('key'), createdHere: !!p.get('new'), srv: p.get('srv') || known?.srv || null, pk, sk }
  }
  if (recent[0]) return { ...recent[0], createdHere: false, srv: recent[0].srv || null, pk: recent[0].pk || null, sk: recent[0].sk || null }
  return { ws: randToken(9), key: randToken(16), createdHere: true, srv: null, pk: null, sk: null }
})()
// The sync server that served this page is used automatically; "none" = explicitly disabled.
let serverUrl = srv && srv !== 'none' ? srv : null
function linkParams({ edit = true, page = null, withSrv = true } = {}) {
  const p = new URLSearchParams({ ws, key })
  if (serverUrl && withSrv) p.set('srv', serverUrl)
  if (pk) p.set('pk', pk)
  if (pk && sk && edit) p.set('sk', sk)
  if (page) p.set('p', page)
  return p
}
const hashFor = (w) => {
  const p = new URLSearchParams({ ws: w.ws, key: w.key })
  for (const k of ['srv', 'pk', 'sk']) if (w[k]) p.set(k, w[k])
  return p.toString()
}
const setHash = (page) => history.replaceState(null, '', '#' + linkParams({ page }).toString())
setHash(params().get('p'))
addEventListener('hashchange', () => {
  const p = params()
  if (p.get('ws') !== ws) location.reload()
  else if (p.get('p') && p.get('p') !== curId) openPage(p.get('p'))
})
/** edit=true: link that can edit; false: view-only link. */
const inviteLink = (edit) => {
  const p = linkParams({ edit, withSrv: !servedByServer })
  const base = servedByServer ? serverUrl.replace(/\/+$/, '') + '/' : location.href.split('#')[0]
  return base + '#' + p.toString()
}
let servedByServer = false
let readOnly = !!pk && !sk

async function newWorkspace() {
  const keys = await generateWriteKeys()
  location.hash = hashFor({ ws: randToken(9), key: randToken(16), srv: serverUrl, ...keys }) + '&new=1'
}

/* ---------------- doc ---------------- */
const doc = new Y.Doc()
const meta = doc.getMap('meta')
const pages = doc.getMap('pages')
const undo = new Y.UndoManager(pages, { trackedOrigins: new Set(['local', HTMLTextAreaElement]), captureTimeout: 400 })

function createPage(parent = null, title = '', blocks = [{}], icon = '') {
  const id = uid()
  doc.transact(() => {
    const p = new Y.Map()
    p.set('title', new Y.Text(title))
    p.set('icon', icon)
    p.set('parent', parent)
    p.set('order', Date.now())
    p.set('created', Date.now())
    const arr = new Y.Array()
    arr.push(blocks.map(makeBlock))
    p.set('blocks', arr)
    pages.set(id, p)
  }, 'local')
  return id
}
function seedWorkspace() {
  doc.transact(() => {
    meta.set('name', me.name.split(' ')[0] + "'s workspace")
    const home = createPage(null, 'Welcome to PeerPad', [
      { type: 'callout', text: 'Everything here syncs directly between browsers. No server stores your notes.' },
      { type: 'h2', text: 'Invite your team' },
      { type: 'number', text: 'Click "Share" in the top-right corner and copy the invite link.' },
      { type: 'number', text: 'Send it to a teammate. When they open it, your browsers connect and merge edits live.' },
      { type: 'number', text: 'Edit the same page together. Colored bars show who is typing where.' },
      { type: 'h2', text: 'Writing' },
      { type: 'todo', text: 'Type "/" on an empty line to pick a block type', checked: false },
      { type: 'todo', text: 'Try markdown: "# " heading, "- " list, "[] " to-do, "> " quote, "```" code', checked: false },
      { type: 'todo', text: 'Drag the ⋮⋮ handle to reorder blocks, Tab to indent', checked: true },
      { type: 'divider' },
      { type: 'quote', text: 'With a sync server, edits reach teammates even when you are offline. Without one, at least one person must be online. Each browser keeps a full offline copy either way.' },
    ], '👋')
    createPage(home, 'Meeting notes', [
      { type: 'h3', text: 'Agenda' },
      { type: 'bullet', text: 'Roadmap review' },
      { type: 'bullet', text: 'Open questions', indent: 0 },
      { type: 'bullet', text: 'Who owns the launch checklist?', indent: 1 },
      { type: 'p', text: '' },
    ], '🗓️')
    createPage(null, 'Project tasks', [
      { type: 'todo', text: 'Draft the spec', checked: true },
      { type: 'todo', text: 'Review with the team' },
      { type: 'todo', text: 'Ship it' },
    ], '✅')
  }, 'local')
}

/* ---------------- layout ---------------- */
const app = $('#app')
app.append(
  h('aside', { class: 'side', id: 'side' },
    h('div', { class: 'ws-head' },
      h('button', { class: 'ws-switch', id: 'wsSwitch', title: 'Switch workspace' },
        h('span', { class: 'ws-badge', id: 'wsBadge' }), h('span', { class: 'ws-name', id: 'wsName' }), h('span', { class: 'chev' }, '▾')),
      h('button', { class: 'icon-btn only-mobile', onclick: () => document.body.classList.remove('nav-open'), 'aria-label': 'Close sidebar' }, '✕')),
    h('div', { class: 'net', id: 'net' }),
    h('input', { class: 'search', id: 'search', placeholder: 'Search pages', type: 'search' }),
    h('div', { class: 'side-label' }, 'Pages'),
    h('nav', { class: 'tree', id: 'tree' }),
    h('button', { class: 'new-page needs-edit', onclick: () => !readOnly && openPage(createPage(null)) }, '+ New page'),
    h('div', { class: 'side-label' }, 'People here'),
    h('div', { class: 'people', id: 'people' })),
  h('main', { class: 'main' },
    h('header', { class: 'top' },
      h('button', { class: 'icon-btn only-mobile', onclick: () => document.body.classList.add('nav-open'), 'aria-label': 'Open sidebar' }, '☰'),
      h('div', { class: 'crumbs', id: 'crumbs' }),
      h('span', { class: 'ro-badge', id: 'roBadge', hidden: true, title: 'You opened a view-only link' }, 'View only'),
      h('div', { class: 'faces', id: 'faces' }),
      h('button', { class: 'btn', id: 'shareBtn' }, 'Share'),
      h('button', { class: 'icon-btn', id: 'moreBtn', 'aria-label': 'Page options' }, '⋯')),
    h('div', { class: 'scroll', id: 'scroll' }, h('article', { class: 'page', id: 'page' }))),
  h('div', { class: 'scrim', onclick: () => document.body.classList.remove('nav-open') }),
)

/* ---------------- popover menu ---------------- */
let menu = null
function closeMenu() { menu?.el.remove(); menu = null }
function openMenu(anchor, items, { filter = '', onClose, keyboard = false } = {}) {
  closeMenu()
  const el = h('div', { class: 'menu', role: 'menu' })
  const state = { el, items, active: 0, filter, onClose, keyboard }
  menu = state
  const render = () => {
    el.innerHTML = ''
    const f = state.filter.toLowerCase()
    state.visible = items.filter((it) => it.sep || !f || it.label.toLowerCase().includes(f) || (it.type || '').includes(f))
    if (f) state.visible = state.visible.filter((i) => !i.sep && !i.heading)
    if (!state.visible.length) { el.append(h('div', { class: 'menu-empty' }, 'No matches')); return }
    let idx = 0
    for (const it of state.visible) {
      if (it.sep) { el.append(h('div', { class: 'menu-sep' })); continue }
      if (it.heading) { el.append(h('div', { class: 'menu-heading' }, it.heading)); continue }
      const my = idx++
      it._i = my
      el.append(h('button', {
        class: 'menu-item' + (my === state.active ? ' active' : '') + (it.danger ? ' danger' : ''),
        onmousedown: (e) => e.preventDefault(),
        onclick: () => { closeMenu(); it.run() },
        onmouseenter: () => { state.active = my; el.querySelectorAll('.menu-item').forEach((b, j) => b.classList.toggle('active', j === my)) },
      }, h('span', { class: 'mi-icon' }, it.icon || ''), h('span', { class: 'mi-label' }, it.label), it.hint ? h('span', { class: 'mi-hint' }, it.hint) : null))
    }
  }
  state.render = render
  state.choices = () => state.visible.filter((i) => !i.sep && !i.heading)
  render()
  document.body.append(el)
  const r = anchor.getBoundingClientRect()
  const top = r.bottom + 6 + el.offsetHeight > innerHeight ? Math.max(8, r.top - el.offsetHeight - 6) : r.bottom + 6
  el.style.top = top + 'px'
  el.style.left = Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8)) + 'px'
  return state
}
document.addEventListener('mousedown', (e) => { if (menu && !menu.el.contains(e.target)) { const f = menu.onClose; closeMenu(); f?.() } })
function menuKey(e) {
  if (!menu?.keyboard) return false
  const ch = menu.choices()
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (!ch.length) return true
    menu.active = (menu.active + (e.key === 'ArrowDown' ? 1 : -1) + ch.length) % ch.length
    menu.render()
    menu.el.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
    return true
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    if (!ch.length) { closeMenu(); return false }
    e.preventDefault()
    const it = ch[menu.active] || ch[0]
    closeMenu(); it.run()
    return true
  }
  if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return true }
  return false
}

/* ---------------- toast & modal ---------------- */
function toast(msg) {
  const t = h('div', { class: 'toast' }, msg)
  document.body.append(t)
  setTimeout(() => t.classList.add('out'), 1800)
  setTimeout(() => t.remove(), 2200)
}
function modal(title, body, actions = []) {
  const close = () => wrap.remove()
  const wrap = h('div', { class: 'modal-wrap', onmousedown: (e) => { if (e.target === wrap) close() } },
    h('div', { class: 'modal', role: 'dialog', 'aria-label': title },
      h('h2', {}, title), body,
      h('div', { class: 'modal-actions' }, ...actions.map((a) => h('button', { class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), onclick: () => { if (a.run?.() !== false) close() } }, a.label)))))
  document.body.append(wrap)
  wrap.querySelector('input,button.primary,button')?.focus()
  return close
}
function confirmBox(title, text, label, run) {
  modal(title, h('p', { class: 'muted' }, text), [{ label: 'Cancel' }, { label, danger: true, run }])
}
async function copy(text, input) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard') }
  catch { input?.select(); toast('Press Ctrl+C to copy') }
}

/* ---------------- text binding (textarea <-> Y.Text) ---------------- */
function autosize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px' }
function applyDiff(ytext, next, origin) {
  const prev = ytext.toString()
  if (prev === next) return
  let a = 0
  const max = Math.min(prev.length, next.length)
  while (a < max && prev[a] === next[a]) a++
  let b = 0
  while (b < max - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++
  doc.transact(() => {
    const del = prev.length - a - b
    if (del) ytext.delete(a, del)
    const ins = next.slice(a, next.length - b)
    if (ins) ytext.insert(a, ins)
  }, origin)
}
function bindText(ta, ytext) {
  ta.value = ytext.toString()
  const obs = (e) => {
    if (e.transaction.origin === ta) return
    const focused = document.activeElement === ta
    let s = ta.selectionStart, en = ta.selectionEnd, idx = 0
    if (focused) {
      for (const op of e.delta) {
        if (op.retain) idx += op.retain
        else if (op.insert) {
          const n = op.insert.length
          if (idx < s) s += n
          if (idx < en) en += n
          idx += n
        } else if (op.delete) {
          const n = op.delete
          if (idx < s) s -= Math.min(n, s - idx)
          if (idx < en) en -= Math.min(n, en - idx)
        }
      }
    }
    ta.value = ytext.toString()
    autosize(ta)
    if (focused) ta.setSelectionRange(s, en)
  }
  ytext.observe(obs)
  return () => ytext.unobserve(obs)
}

/* ---------------- block types ---------------- */
const TYPES = [
  { type: 'p', label: 'Text', icon: '¶', ph: "Type '/' for commands" },
  { type: 'h1', label: 'Heading 1', icon: 'H1', ph: 'Heading 1', md: '#' },
  { type: 'h2', label: 'Heading 2', icon: 'H2', ph: 'Heading 2', md: '##' },
  { type: 'h3', label: 'Heading 3', icon: 'H3', ph: 'Heading 3', md: '###' },
  { type: 'bullet', label: 'Bulleted list', icon: '•', ph: 'List', md: '-' },
  { type: 'number', label: 'Numbered list', icon: '1.', ph: 'List', md: '1.' },
  { type: 'todo', label: 'To-do', icon: '☐', ph: 'To-do', md: '[]' },
  { type: 'quote', label: 'Quote', icon: '❝', ph: 'Quote', md: '>' },
  { type: 'callout', label: 'Callout', icon: '💡', ph: 'Callout' },
  { type: 'code', label: 'Code', icon: '</>', ph: 'Code', md: '```' },
  { type: 'divider', label: 'Divider', icon: '—', md: '---' },
  { type: 'pagelink', label: 'Sub-page', icon: '↳', hint: 'new page inside' },
  { type: 'image', label: 'Image', icon: '▣', hint: 'upload, paste or drop', ph: 'Add a caption' },
  { type: 'table', label: 'Table', icon: '▦' },
  { type: 'chart', label: 'Chart', icon: '▥', hint: 'bar or line', ph: 'Chart title' },
  { type: 'toc', label: 'Table of contents', icon: '≡' },
]
// Blocks whose content is not a single line of text get their own renderer.
const RICH = { image: imageBlock, table: tableBlock, chart: chartBlock, toc: tocBlock }
const kindOf = (type) => (RICH[type] ? type : 'text')
const ATOMIC = new Set(['divider', 'pagelink', 'table', 'toc']) // no editable caption: Backspace deletes the block
const T = Object.fromEntries(TYPES.map((t) => [t.type, t]))
const LISTY = new Set(['bullet', 'number', 'todo'])
const MD_RULES = [
  [/^###\s$/, 'h3'], [/^##\s$/, 'h2'], [/^#\s$/, 'h1'], [/^[-*]\s$/, 'bullet'], [/^1[.)]\s$/, 'number'],
  [/^\[\s?\]\s$/, 'todo'], [/^\[x\]\s$/i, 'todo', true], [/^>\s$/, 'quote'], [/^```$/, 'code'], [/^---$/, 'divider'],
]

/* ---------------- current page ---------------- */
let curId = null
let cur = null // { id, map, blocks, nodes: Map<key,node>, byMap: WeakMap, container, cleanups:[] }

function pageTitle(id) {
  const p = pages.get(id)
  return (p && p.get('title')?.toString().trim()) || 'Untitled'
}
function pageIcon(id) { return pages.get(id)?.get('icon') || '' }
function children(parent) {
  const out = []
  pages.forEach((p, id) => { if ((p.get('parent') || null) === parent) out.push(id) })
  return out.sort((a, b) => pages.get(a).get('order') - pages.get(b).get('order'))
}
function ancestors(id) {
  const out = []
  let p = pages.get(id)?.get('parent'), guard = 0
  while (p && pages.has(p) && guard++ < 50) { out.unshift(p); p = pages.get(p).get('parent') }
  return out
}

function teardown() {
  if (!cur) return
  cur.cleanups.forEach((f) => f())
  for (const n of cur.nodes.values()) n.cleanup()
  cur = null
}

function openPage(id) {
  if (!pages.has(id)) id = children(null)[0]
  closeMenu()
  teardown()
  curId = id || null
  setHash(curId)
  document.body.classList.remove('nav-open')
  const pageEl = $('#page')
  pageEl.innerHTML = ''
  renderSidebar()
  updatePresence()
  if (!curId) {
    pageEl.append(h('div', { class: 'empty' },
      h('div', { class: 'empty-mark' }, '⇄'),
      h('h1', {}, connected() ? 'Syncing…' : 'Waiting for teammates'),
      h('p', { class: 'muted' }, createdHere
        ? 'This workspace has no pages yet.'
        : 'Pages will appear once someone who has this workspace is online. You can also start writing now; your pages will merge with theirs.'),
      readOnly ? null : h('button', { class: 'btn primary', onclick: () => openPage(createPage(null)) }, 'Create a page')))
    $('#crumbs').innerHTML = ''
    return
  }
  const map = pages.get(curId)
  const blocks = map.get('blocks')
  cur = { id: curId, map, blocks, nodes: new Map(), byMap: new WeakMap(), cleanups: [] }

  // icon
  const iconBtn = h('button', { class: 'page-icon' + (map.get('icon') ? '' : ' empty-icon'), title: 'Change icon' }, map.get('icon') || '+ Add icon')
  iconBtn.onclick = () => !readOnly && openMenuGrid(iconBtn)
  const iconObs = () => { iconBtn.textContent = map.get('icon') || '+ Add icon'; iconBtn.classList.toggle('empty-icon', !map.get('icon')) }
  map.observe(iconObs)
  cur.cleanups.push(() => map.unobserve(iconObs))

  // title
  const title = h('textarea', { class: 'title', rows: 1, placeholder: 'Untitled', spellcheck: 'true', 'aria-label': 'Page title' })
  title.readOnly = readOnly
  cur.cleanups.push(bindText(title, map.get('title')))
  title.addEventListener('input', () => { applyDiff(map.get('title'), title.value.replace(/\n/g, ' '), title); autosize(title) })
  title.addEventListener('keydown', (e) => {
    if (readOnly) return
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && title.selectionStart === title.value.length)) {
      e.preventDefault()
      if (e.key === 'Enter' && (!blocks.length || blocks.get(0).get('text').length)) doc.transact(() => blocks.insert(0, [makeBlock()]), 'local')
      focusBlock(0, 'start')
    }
  })
  title.addEventListener('focus', () => setFocusBlock(null))

  const container = h('div', { class: 'blocks' })
  cur.container = container
  const tail = h('div', { class: 'tail', title: 'Click to add a block' })
  tail.onclick = () => {
    if (readOnly) return
    const last = blocks.get(blocks.length - 1)
    if (!last || last.get('type') !== 'p' || last.get('text').length) doc.transact(() => blocks.push([makeBlock()]), 'local')
    focusBlock(blocks.length - 1, 'end')
  }
  pageEl.append(iconBtn, title, container, tail)
  requestAnimationFrame(() => autosize(title))

  const deep = (events) => {
    if (events.every((e) => e.target instanceof Y.Text)) return
    renderBlocks()
  }
  blocks.observeDeep(deep)
  cur.cleanups.push(() => blocks.unobserveDeep(deep))
  renderBlocks()
  renderCrumbs()
  if (!title.value && !readOnly) title.focus()
}

function renderCrumbs() {
  const c = $('#crumbs')
  c.innerHTML = ''
  if (!curId) return
  for (const id of [...ancestors(curId), curId]) {
    if (c.childNodes.length) c.append(h('span', { class: 'sep' }, '/'))
    c.append(h('button', { class: 'crumb', onclick: () => openPage(id) }, (pageIcon(id) ? pageIcon(id) + ' ' : '') + pageTitle(id)))
  }
}

function openMenuGrid(anchor) {
  closeMenu()
  const el = h('div', { class: 'menu emoji-grid' },
    ...EMOJI.map((e) => h('button', { class: 'emoji', onclick: () => { closeMenu(); doc.transact(() => cur.map.set('icon', e), 'local'); renderSidebar() } }, e)),
    h('button', { class: 'menu-item danger wide', onclick: () => { closeMenu(); doc.transact(() => cur.map.set('icon', ''), 'local'); renderSidebar() } }, 'Remove icon'))
  menu = { el }
  document.body.append(el)
  const r = anchor.getBoundingClientRect()
  el.style.top = r.bottom + 6 + 'px'
  el.style.left = Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8)) + 'px'
}

/* ---------------- blocks ---------------- */
function renderBlocks() {
  if (!cur) return
  const arr = cur.blocks.toArray()
  const keys = []
  const seen = new Set()
  for (let i = 0; i < arr.length; i++) {
    let k = arr[i].get('id') || 'i' + i
    if (seen.has(k)) k += '~' + i
    seen.add(k)
    keys.push(k)
  }
  // remove stale first so surviving nodes (and focus) never move
  for (const [k, n] of cur.nodes) {
    const i = keys.indexOf(k)
    if (i < 0 || arr[i] !== n.bm || n.kind !== kindOf(arr[i].get('type'))) { n.cleanup(); n.el.remove(); cur.nodes.delete(k) }
  }
  let prev = null
  const numStack = []
  arr.forEach((bm, i) => {
    const k = keys[i]
    let n = cur.nodes.get(k)
    if (!n) { n = createNode(bm); cur.nodes.set(k, n); cur.byMap.set(bm, n) }
    const want = prev ? prev.nextSibling : cur.container.firstChild
    if (want !== n.el) cur.container.insertBefore(n.el, want)
    prev = n.el
    // numbering per indent level
    const ind = bm.get('indent') || 0
    numStack.length = ind + 1
    if (bm.get('type') === 'number') numStack[ind] = (numStack[ind] || 0) + 1
    else numStack[ind] = 0
    n.update(numStack[ind])
  })
  renderPeerMarks()
}

function idxOf(bm) { return cur.blocks.toArray().indexOf(bm) }
function setType(bm, type) { doc.transact(() => bm.set('type', type), 'local') }

function focusBlock(i, pos = 'end') {
  if (!cur) return
  const bm = cur.blocks.get(Math.max(0, Math.min(i, cur.blocks.length - 1)))
  const n = bm && cur.byMap.get(bm)
  if (!n) return
  n.beforeFocus?.()
  const ta = n.ta
  ta.focus()
  const p = pos === 'end' ? ta.value.length : pos === 'start' ? 0 : pos
  ta.setSelectionRange(p, p)
}

function cloneBlock(bm) {
  return makeBlock(specOf(bm))
}
function moveBlock(from, to) {
  if (from === to || from + 1 === to) return
  doc.transact(() => {
    const bm = cur.blocks.get(from)
    const copy = cloneBlock(bm)
    cur.blocks.delete(from, 1)
    cur.blocks.insert(to > from ? to - 1 : to, [copy])
  }, 'local')
}

/** Put a new block of another structure where `bm` is (if empty) or right after it. */
function placeBlock(bm, nb) {
  const i = idxOf(bm)
  const replace = bm.get('type') === 'p' && !bm.get('text').length
  doc.transact(() => {
    if (replace) cur.blocks.delete(i, 1)
    cur.blocks.insert(replace ? i : i + 1, [nb])
    if ((replace ? i : i + 1) === cur.blocks.length - 1) cur.blocks.push([makeBlock()])
  }, 'local')
  return cur.byMap.get(nb)
}
function turnInto(bm, type) {
  const i = idxOf(bm)
  if (type === 'image') return pickImages((files) => insertImages(files, bm))
  if (type === 'table' || type === 'chart' || type === 'toc') {
    const n = placeBlock(bm, makeBlock({ type }))
    if (type === 'table') n?.rich?.focusFirst?.()
    if (type === 'chart') n?.rich?.showData?.()
    return
  }
  if (type === 'pagelink') {
    const child = createPage(curId, bm.get('text').toString())
    doc.transact(() => { bm.set('type', 'pagelink'); bm.set('ref', child) }, 'local')
    openPage(child)
    return
  }
  if (type === 'divider') {
    doc.transact(() => {
      bm.set('type', 'divider')
      const t = bm.get('text'); if (t.length) t.delete(0, t.length)
      if (i === cur.blocks.length - 1) cur.blocks.insert(i + 1, [makeBlock()])
    }, 'local')
    focusBlock(i + 1, 'start')
    return
  }
  setType(bm, type)
  focusBlock(i, 'end')
}

/* ---------------- rich blocks: context + images ---------------- */
const richCtx = {
  readOnly: () => readOnly,
  transact: (fn) => doc.transact(fn, 'local'),
  bindText, applyDiff, autosize,
  onFocus: () => setFocusBlock(null),
  assets: () => net?.assets || null,
  headings: () => (cur ? cur.blocks.toArray().filter((b) => /^h[123]$/.test(b.get('type'))).map((b) => ({ bm: b, type: b.get('type'), text: b.get('text').toString() })) : []),
  scrollToBlock: (b) => { const n = cur?.byMap.get(b); if (n) { n.el.scrollIntoView({ behavior: 'smooth', block: 'start' }); focusBlock(idxOf(b), 'end') } },
}
function pickImages(onFiles, multiple = true) {
  if (readOnly) return
  const inp = h('input', { type: 'file', accept: 'image/*', multiple, hidden: true })
  inp.onchange = () => { if (inp.files.length) onFiles([...inp.files]); inp.remove() }
  document.body.append(inp)
  inp.click()
}
const MAX_INLINE = 1.5 * 1024 * 1024
/** Encrypt + upload to the sync server, or embed small images when there is no server. */
async function storeImage(file) {
  const { bytes, mime } = await processImage(file)
  if (net?.assets) return { asset: await net.assets.upload(bytes), mime }
  if (bytes.length > MAX_INLINE) throw new Error('Images over 1.5 MB need a sync server (workspace menu → Sync server…).')
  return { data: bytes, mime }
}
async function insertImages(files, afterBm) {
  const imgs = files.filter((f) => f.type.startsWith('image/'))
  if (!imgs.length || readOnly || !cur) return
  toast(imgs.length > 1 ? `Uploading ${imgs.length} images…` : 'Uploading image…')
  let anchor = afterBm
  for (const f of imgs) {
    try {
      const src = await storeImage(f)
      const nb = makeBlock({ type: 'image', ...src })
      if (anchor) placeBlock(anchor, nb)
      else doc.transact(() => cur.blocks.push([nb]), 'local')
      anchor = nb
    } catch (e) {
      toast(e.message || 'Upload failed')
    }
  }
}
async function replaceImage(bm, file) {
  if (!file) return
  try {
    const src = await storeImage(file)
    doc.transact(() => { for (const k of ['asset', 'url', 'data', 'mime']) bm.delete(k); for (const [k, v] of Object.entries(src)) bm.set(k, v) }, 'local')
  } catch (e) { toast(e.message || 'Upload failed') }
}

let tocQueued = false
function refreshTocsSoon() {
  if (tocQueued) return
  tocQueued = true
  requestAnimationFrame(() => { tocQueued = false; if (cur) for (const n of cur.nodes.values()) if (n.kind === 'toc') n.rich.update() })
}

let dragFrom = -1
function createNode(bm) {
  const ta = h('textarea', { class: 'bt', rows: 1, spellcheck: 'true' })
  const check = h('input', { type: 'checkbox', class: 'chk', 'aria-label': 'Done' })
  const marker = h('div', { class: 'marker' }, check)
  const handle = h('button', { class: 'handle', draggable: 'true', title: 'Drag to move, click for options', 'aria-label': 'Block options' }, '⋮⋮')
  const link = h('button', { class: 'plink' })
  const preview = h('div', { class: 'preview' })
  const body = h('div', { class: 'body' }, marker, ta, preview, link)
  const el = h('div', { class: 'block' }, handle, body)
  const unbind = bindText(ta, bm.get('text'))
  let slashAt = -1
  const kind = kindOf(bm.get('type'))
  const rich = RICH[kind] ? RICH[kind](richCtx, bm, body, ta) : null

  // Inline formatting: show rendered text, switch to the raw text while editing.
  const refreshPreview = () => {
    const type = bm.get('type'), text = ytext.toString()
    const show = kind === 'text' && document.activeElement !== ta && !['code', 'divider', 'pagelink'].includes(type) && hasMarkup(text)
    el.classList.toggle('previewing', show)
    if (show) preview.innerHTML = renderInline(text)
  }
  const textObs = () => { refreshPreview(); if (/^h[123]$/.test(bm.get('type'))) refreshTocsSoon() }
  const ytext = bm.get('text') // keep a reference: a deleted block no longer returns it
  ytext.observe(textObs)
  ta.addEventListener('blur', refreshPreview)
  preview.addEventListener('mousedown', (e) => {
    if (e.target.closest('a')) return
    e.preventDefault()
    n.beforeFocus()
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
  })

  const n = {
    bm, el, ta, kind, rich,
    beforeFocus() { el.classList.remove('previewing') },
    update(num) {
      const type = bm.get('type') || 'p'
      el.dataset.type = type
      marker.dataset.num = num ? num + '.' : ''
      el.style.setProperty('--indent', bm.get('indent') || 0)
      el.classList.toggle('done', !!bm.get('checked'))
      check.checked = !!bm.get('checked')
      ta.placeholder = T[type]?.ph || ''
      ta.readOnly = readOnly || ATOMIC.has(type)
      check.disabled = readOnly
      if (type === 'pagelink') {
        const ref = bm.get('ref')
        link.textContent = pages.has(ref) ? (pageIcon(ref) || '📄') + '  ' + pageTitle(ref) : '⚠  Deleted page'
        link.classList.toggle('dead', !pages.has(ref))
      }
      rich?.update()
      refreshPreview()
      requestAnimationFrame(() => autosize(ta))
    },
    cleanup() { unbind(); ytext.unobserve(textObs); rich?.cleanup() },
  }

  link.onclick = () => { const ref = bm.get('ref'); if (pages.has(ref)) openPage(ref) }
  check.onchange = () => doc.transact(() => bm.set('checked', check.checked), 'local')
  ta.addEventListener('focus', () => setFocusBlock(bm.get('id')))

  ta.addEventListener('input', (e) => {
    applyDiff(bm.get('text'), ta.value, ta)
    autosize(ta)
    const type = bm.get('type')
    const caret = ta.selectionStart
    // slash menu
    if (e.data === '/' && (caret === 1 || /\s/.test(ta.value[caret - 2]))) {
      slashAt = caret - 1
      openMenu(ta, TYPES.map((t) => ({ ...t, run: () => pickSlash(t.type) })), { keyboard: true, onClose: () => (slashAt = -1) })
      positionMenuAtCaret()
    } else if (slashAt >= 0 && menu) {
      const q = ta.value.slice(slashAt + 1, caret)
      if (caret <= slashAt || /[\n/]|\s\s|^\s/.test(q) || q.length > 24 || ta.value[slashAt] !== '/') { closeMenu(); slashAt = -1 }
      else { menu.filter = q; menu.active = 0; menu.render() }
    }
    // markdown shortcuts
    if (type === 'p') {
      const head = ta.value.slice(0, caret)
      for (const [re, to, checked] of MD_RULES) {
        if (re.test(head)) {
          closeMenu()
          doc.transact(() => {
            bm.get('text').delete(0, head.length)
            if (checked) bm.set('checked', true)
          }, 'local')
          turnInto(bm, to)
          break
        }
      }
    }
  })

  function pickSlash(type) {
    const caret = ta.selectionStart
    if (slashAt >= 0 && ta.value[slashAt] === '/') doc.transact(() => bm.get('text').delete(slashAt, Math.max(1, caret - slashAt)), 'local')
    slashAt = -1
    turnInto(bm, type)
  }
  function positionMenuAtCaret() {
    if (!menu) return
    const r = ta.getBoundingClientRect()
    menu.el.style.top = (r.bottom + 6 + menu.el.offsetHeight > innerHeight ? Math.max(8, r.top - menu.el.offsetHeight - 6) : r.bottom + 6) + 'px'
  }

  ta.addEventListener('keydown', (e) => {
    if (menuKey(e)) return
    if (readOnly) return
    if (e.isComposing) return
    const type = bm.get('type')
    const i = idxOf(bm)
    const s = ta.selectionStart, en = ta.selectionEnd, text = ta.value
    const ind = bm.get('indent') || 0
    const mod = e.metaKey || e.ctrlKey
    if (mod && !ATOMIC.has(type) && type !== 'code') {
      const k = e.key.toLowerCase()
      const fmt = { b: ['**'], i: ['*'], e: ['`'] }[k] || (k === 'x' && e.shiftKey ? ['~~'] : null)
      if (fmt) { e.preventDefault(); e.stopPropagation(); wrapSelection(ta, fmt[0]); return }
      if (k === 'k') {
        e.preventDefault(); e.stopPropagation()
        const sel = ta.value.slice(s, en) || 'link'
        ta.setRangeText(`[${sel}](https://)`, s, en)
        ta.setSelectionRange(s + sel.length + 3, s + sel.length + 11)
        ta.dispatchEvent(new Event('input'))
        return
      }
    }
    if (RICH[type] || ATOMIC.has(type)) {
      // image / chart caption, or a block without text: Enter adds a paragraph below, Backspace removes it
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (type === 'pagelink') { link.click(); return }
        doc.transact(() => cur.blocks.insert(i + 1, [makeBlock()]), 'local')
        focusBlock(i + 1, 'start')
        return
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && (ATOMIC.has(type) || (!text && s === 0))) {
        e.preventDefault()
        doc.transact(() => { cur.blocks.delete(i, 1); if (!cur.blocks.length) cur.blocks.push([makeBlock()]) }, 'local')
        focusBlock(Math.max(0, i - 1), 'end')
        return
      }
      if (e.key === 'Tab') { e.preventDefault(); return }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      if (type === 'code' && !(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      if (type === 'pagelink') { link.click(); return }
      if (LISTY.has(type) && text === '') {
        if (ind > 0) doc.transact(() => bm.set('indent', ind - 1), 'local')
        else setType(bm, 'p')
        return
      }
      if (s === 0 && text.length && type !== 'divider') {
        doc.transact(() => cur.blocks.insert(i, [makeBlock({ indent: ind })]), 'local')
        return
      }
      const after = text.slice(en)
      doc.transact(() => {
        const yt = bm.get('text')
        if (text.length - s) yt.delete(s, text.length - s)
        cur.blocks.insert(i + 1, [makeBlock({ type: LISTY.has(type) ? type : 'p', text: after, indent: ind })])
      }, 'local')
      focusBlock(i + 1, 'start')
      return
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && (type === 'divider' || type === 'pagelink')) {
      e.preventDefault()
      doc.transact(() => cur.blocks.delete(i, 1), 'local')
      focusBlock(i - 1, 'end')
      return
    }
    if (e.key === 'Backspace' && s === 0 && en === 0) {
      if (ind > 0) { e.preventDefault(); doc.transact(() => bm.set('indent', ind - 1), 'local'); return }
      if (type !== 'p') { e.preventDefault(); setType(bm, 'p'); return }
      if (i === 0) { if (!text && cur.blocks.length > 1) { e.preventDefault(); doc.transact(() => cur.blocks.delete(0, 1), 'local'); focusBlock(0, 'start') } return }
      e.preventDefault()
      const prev = cur.blocks.get(i - 1)
      const pt = prev.get('type')
      if (ATOMIC.has(pt) || RICH[pt]) {
        if (!text) { doc.transact(() => cur.blocks.delete(i, 1), 'local'); focusBlock(i - 1, 'end') }
        else doc.transact(() => cur.blocks.delete(i - 1, 1), 'local')
        return
      }
      const ptext = prev.get('text')
      const at = ptext.length
      doc.transact(() => { if (text) ptext.insert(at, text); cur.blocks.delete(i, 1) }, 'local')
      focusBlock(i - 1, at)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      if (type === 'code') { if (!e.shiftKey) { ta.setRangeText('  ', s, en, 'end'); ta.dispatchEvent(new Event('input')) } return }
      const next = Math.max(0, Math.min(6, ind + (e.shiftKey ? -1 : 1)))
      if (next !== ind) doc.transact(() => bm.set('indent', next), 'local')
      return
    }
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 24
    const single = ta.scrollHeight < lh * 1.8
    if ((e.key === 'ArrowUp' && (s === 0 || single)) || (e.key === 'ArrowLeft' && s === 0 && en === 0)) {
      if (i > 0) { e.preventDefault(); focusBlock(i - 1, e.key === 'ArrowLeft' ? 'end' : Math.min(s, cur.blocks.get(i - 1).get('text').length)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); $('.title').focus() }
      return
    }
    if ((e.key === 'ArrowDown' && (en === text.length || single)) || (e.key === 'ArrowRight' && s === text.length && en === s)) {
      if (i < cur.blocks.length - 1) { e.preventDefault(); focusBlock(i + 1, e.key === 'ArrowRight' ? 'start' : Math.min(s, cur.blocks.get(i + 1).get('text').length)) }
    }
  })

  // block options + drag
  handle.addEventListener('click', () => {
    if (readOnly) return
    const i = idxOf(bm)
    const type = bm.get('type')
    const specific = type === 'image' ? [
      { heading: 'Image width' },
      ...[25, 50, 75, 100].map((w) => ({ label: w + '%', icon: (bm.get('width') || 100) === w ? '✓' : '', run: () => doc.transact(() => bm.set('width', w), 'local') })),
      { label: 'Replace image', icon: '⟳', run: () => pickImages((files) => replaceImage(bm, files[0]), false) },
      { label: 'Open full size', icon: '↗', run: () => { const src = n.rich?.src(); if (src) window.open(src, '_blank', 'noopener') } },
    ] : type === 'chart' ? [
      { label: bm.get('chart') === 'line' ? 'Show as bars' : 'Show as line', icon: '▥', run: () => doc.transact(() => bm.set('chart', bm.get('chart') === 'line' ? 'bar' : 'line'), 'local') },
      { label: 'Edit data', icon: '▦', run: () => n.rich?.showData() },
    ] : RICH[type] ? [] : [
      { heading: 'Turn into' },
      ...TYPES.filter((t) => TEXT_TYPES.includes(t.type) || t.type === 'divider').map((t) => ({ ...t, run: () => turnInto(bm, t.type) })),
    ]
    openMenu(handle, [
      ...specific,
      ...(specific.length ? [{ sep: true }] : []),
      { label: 'Duplicate', icon: '⧉', run: () => doc.transact(() => cur.blocks.insert(i + 1, [cloneBlock(bm)]), 'local') },
      { label: 'Move up', icon: '↑', run: () => i > 0 && moveBlock(i, i - 1) },
      { label: 'Move down', icon: '↓', run: () => moveBlock(i, i + 2) },
      { label: 'Delete', icon: '🗑', danger: true, run: () => doc.transact(() => { cur.blocks.delete(i, 1); if (!cur.blocks.length) cur.blocks.push([makeBlock()]) }, 'local') },
    ])
  })
  handle.addEventListener('dragstart', (e) => {
    if (readOnly) return e.preventDefault()
    dragFrom = idxOf(bm)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', bm.get('text').toString())
    e.dataTransfer.setDragImage(el, 10, 10)
    el.classList.add('dragging')
  })
  handle.addEventListener('dragend', () => { el.classList.remove('dragging'); dragFrom = -1; clearDrop() })
  el.addEventListener('dragover', (e) => {
    if (dragFrom < 0) return
    e.preventDefault()
    const r = el.getBoundingClientRect()
    clearDrop()
    el.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after')
  })
  el.addEventListener('drop', (e) => {
    if (dragFrom < 0) return
    e.preventDefault()
    const i = idxOf(bm)
    const to = el.classList.contains('drop-before') ? i : i + 1
    clearDrop()
    moveBlock(dragFrom, to)
  })
  return n
}
function clearDrop() { document.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after')) }

// Paste: images become image blocks; tab-separated rows (from spreadsheets) become a table;
// Markdown with tables, images or charts becomes those blocks; other multi-line text becomes paragraphs.
document.addEventListener('paste', (e) => {
  const ta = e.target
  if (readOnly || !cur || !(ta instanceof HTMLTextAreaElement)) return
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'))
  const owner = [...cur.nodes.values()].find((x) => x.ta === ta || x.el.contains(ta))
  if (files.length && owner) { e.preventDefault(); insertImages(files, owner.bm); return }
  if (!ta.classList.contains('bt')) return
  const text = e.clipboardData.getData('text/plain')
  const n = [...cur.nodes.values()].find((x) => x.ta === ta)
  if (!n || !text.includes('\n') || n.bm.get('type') === 'code') return
  const lines0 = text.replace(/\r/g, '').split('\n').filter((l) => l.trim())
  const tsv = lines0.length > 1 && lines0.every((l) => l.includes('\t'))
  if (tsv || /^\s*\|.*\|\s*$/m.test(text) || /^!\[.*\]\(.+\)\s*$/m.test(text) || /^```chart/m.test(text)) {
    e.preventDefault()
    const specs = tsv ? [{ type: 'table', rows: lines0.map((l) => l.split('\t')) }] : parseMarkdown(text)
    const i = idxOf(n.bm)
    const replace = !n.bm.get('text').length
    doc.transact(() => {
      if (replace) cur.blocks.delete(i, 1)
      cur.blocks.insert(replace ? i : i + 1, specs.map(makeBlock))
    }, 'local')
    return
  }
  e.preventDefault()
  const lines = text.replace(/\r/g, '').split('\n')
  const i = idxOf(n.bm)
  const s = ta.selectionStart, en = ta.selectionEnd
  const yt = n.bm.get('text')
  const tailText = ta.value.slice(en)
  const parse = (l) => {
    for (const [re, type] of [[/^###\s+/, 'h3'], [/^##\s+/, 'h2'], [/^#\s+/, 'h1'], [/^\s*[-*]\s+\[[xX]\]\s+/, 'todo!'], [/^\s*[-*]\s+\[\s\]\s+/, 'todo'], [/^\s*[-*]\s+/, 'bullet'], [/^\s*\d+[.)]\s+/, 'number'], [/^>\s?/, 'quote']]) {
      const m = l.match(re)
      if (m) return { type: type.replace('!', ''), checked: type.endsWith('!'), text: l.slice(m[0].length), indent: Math.floor((l.match(/^\s*/)[0].length) / 2) }
    }
    return { type: 'p', text: l }
  }
  doc.transact(() => {
    yt.delete(s, ta.value.length - s)
    yt.insert(s, lines[0])
    const rest = lines.slice(1).map(parse)
    if (rest.length) rest[rest.length - 1].text += tailText
    else yt.insert(yt.length, tailText)
    cur.blocks.insert(i + 1, rest.map(makeBlock))
  }, 'local')
  focusBlock(i + lines.length - 1, 'end')
})

// Drop image files onto the page.
$('#scroll').addEventListener('dragover', (e) => { if (!readOnly && e.dataTransfer?.types.includes('Files')) e.preventDefault() })
$('#scroll').addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])]
  if (readOnly || !cur || !files.some((f) => f.type.startsWith('image/'))) return
  e.preventDefault()
  const target = e.target.closest?.('.block')
  const n = target && [...cur.nodes.values()].find((x) => x.el === target)
  insertImages(files, n?.bm || cur.blocks.get(cur.blocks.length - 1))
})

/* ---------------- undo / redo ---------------- */
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (!readOnly) e.shiftKey ? undo.redo() : undo.undo() }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); if (!readOnly) undo.redo() }
  else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#search').focus() }
})

/* ---------------- sidebar ---------------- */
const collapsed = new Set(store.get('pp-collapsed', []))
let sideQueued = false
function renderSidebarSoon() {
  if (sideQueued) return
  sideQueued = true
  requestAnimationFrame(() => { sideQueued = false; renderSidebar(); renderCrumbs(); if (cur) renderBlocks() })
}
function renderSidebar() {
  const name = meta.get('name') || 'Shared workspace'
  $('#wsName').textContent = name
  $('#wsBadge').textContent = name.trim()[0]?.toUpperCase() || 'P'
  document.title = (curId ? pageTitle(curId) + ' · ' : '') + 'PeerPad'
  rememberWorkspace(name)

  const tree = $('#tree')
  tree.innerHTML = ''
  const q = $('#search').value.trim().toLowerCase()
  const peersOn = peersByPage()
  const row = (id, depth) => {
    const kids = children(id)
    const open = !collapsed.has(id) || q
    const dots = (peersOn.get(id) || []).map((p) => h('span', { class: 'dot', style: `background:${p.color}`, title: p.name }))
    const item = h('div', { class: 'item' + (id === curId ? ' active' : ''), style: `--d:${depth}` },
      h('button', { class: 'caret' + (kids.length ? '' : ' none'), 'aria-label': open ? 'Collapse' : 'Expand', onclick: () => { collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); store.set('pp-collapsed', [...collapsed]); renderSidebar() } }, kids.length ? (open ? '▾' : '▸') : '•'),
      h('button', { class: 'item-title', onclick: () => openPage(id) }, h('span', { class: 'ico' }, pageIcon(id) || '📄'), h('span', { class: 'txt' }, pageTitle(id))),
      h('span', { class: 'dots' }, dots),
      h('span', { class: 'acts needs-edit' },
        h('button', { class: 'act', title: 'Add a page inside', onclick: () => { collapsed.delete(id); openPage(createPage(id)) } }, '+'),
        h('button', { class: 'act', title: 'Delete page', onclick: () => askDeletePage(id) }, '×')))
    return [item, ...(open ? kids.flatMap((k) => row(k, depth + 1)) : [])]
  }
  if (q) {
    const hits = []
    pages.forEach((p, id) => { if (pageTitle(id).toLowerCase().includes(q)) hits.push(id) })
    hits.forEach((id) => tree.append(row(id, 0)[0]))
    if (!hits.length) tree.append(h('div', { class: 'muted small pad' }, 'No pages match.'))
  } else {
    const roots = children(null)
    // pages whose parent was deleted by someone else become roots
    pages.forEach((p, id) => { const par = p.get('parent'); if (par && !pages.has(par) && !roots.includes(id)) roots.push(id) })
    roots.forEach((id) => tree.append(...row(id, 0)))
    if (!roots.length) tree.append(h('div', { class: 'muted small pad' }, 'No pages yet.'))
  }
}
$('#search').addEventListener('input', renderSidebar)

function askDeletePage(id) {
  const all = [id]
  for (let i = 0; i < all.length; i++) all.push(...children(all[i]))
  confirmBox(`Delete "${pageTitle(id)}"?`, all.length > 1 ? `This also deletes ${all.length - 1} page(s) inside it, for everyone in the workspace.` : 'This deletes the page for everyone in the workspace.', 'Delete', () => {
    doc.transact(() => all.forEach((p) => pages.delete(p)), 'local')
    if (all.includes(curId)) openPage(children(null)[0])
    toast('Page deleted. Ctrl+Z to undo.')
  })
}

pages.observeDeep((events) => {
  // ignore typing inside blocks; react to page add/remove/title/icon/parent
  if (events.every((e) => e.path[1] === 'blocks')) return
  if (curId && !pages.has(curId)) { openPage(children(null)[0]); return }
  if (!curId && pages.size) { openPage(params().get('p') || children(null)[0]); return }
  renderSidebarSoon()
})
meta.observe(renderSidebarSoon)

/* ---------------- workspaces ---------------- */
function rememberWorkspace(name) {
  const list = store.get('pp-recent', []).filter((w) => w.ws !== ws)
  list.unshift({ ws, key, name, srv: srv === 'none' ? 'none' : serverUrl, pk, sk: readOnly ? null : sk, ts: Date.now() })
  store.set('pp-recent', list.slice(0, 12))
}
$('#wsSwitch').onclick = () => {
  const recent = store.get('pp-recent', [])
  openMenu($('#wsSwitch'), [
    { heading: 'Workspaces' },
    ...recent.map((w) => ({ label: w.name || 'Workspace', icon: w.ws === ws ? '✓' : '', run: () => { if (w.ws !== ws) location.hash = hashFor(w) } })),
    { sep: true },
    ...(readOnly ? [] : [{ label: 'Rename this workspace', icon: '✎', run: renameWorkspace }]),
    { label: 'New workspace', icon: '+', run: newWorkspace },
    { label: 'Join with invite link', icon: '⇢', run: joinDialog },
    { label: 'Sync server…', icon: '☁', hint: serverUrl ? 'on' : 'off', run: serverDialog },
    { label: 'Change my name', icon: '☺', run: profileDialog },
  ])
}
function renameWorkspace() {
  const inp = h('input', { class: 'field', id: 'wsRename', value: meta.get('name') || '' })
  modal('Rename workspace', inp, [{ label: 'Cancel' }, { label: 'Save', primary: true, run: () => doc.transact(() => meta.set('name', inp.value.trim() || 'Shared workspace'), 'local') }])
  inp.select()
}
function joinDialog() {
  const inp = h('input', { class: 'field', id: 'joinLink', placeholder: 'Paste the invite link' })
  const err = h('p', { class: 'error small' })
  modal('Join a workspace', h('div', { class: 'stack' }, inp, err), [{ label: 'Cancel' }, {
    label: 'Join', primary: true, run: () => {
      const hash = inp.value.includes('#') ? inp.value.split('#')[1] : inp.value
      const p = new URLSearchParams(hash)
      if (!p.get('ws') || !p.get('key')) { err.textContent = 'That link is missing the workspace ID or key. Ask for a fresh invite link.'; return false }
      const base = inp.value.includes('#') ? inp.value.split('#')[0] : ''
      if (/^https?:/.test(base) && base.split('#')[0] !== location.href.split('#')[0]) { location.href = inp.value.trim(); return }
      location.hash = hashFor(Object.fromEntries(p))
    },
  }])
}
function profileDialog() {
  const inp = h('input', { class: 'field', id: 'myName', value: me.name })
  let color = me.color
  const sw = h('div', { class: 'swatches' }, ...COLORS.map((c) => h('button', { class: 'swatch' + (c === color ? ' on' : ''), style: `background:${c}`, 'aria-label': c, onclick: (e) => { color = c; sw.querySelectorAll('.swatch').forEach((s) => s.classList.remove('on')); e.currentTarget.classList.add('on') } })))
  modal('Your name and color', h('div', { class: 'stack' }, h('label', { class: 'muted small', for: 'myName' }, 'Shown to teammates next to your cursor'), inp, sw), [{ label: 'Cancel' }, {
    label: 'Save', primary: true, run: () => { me.name = inp.value.trim() || me.name; me.color = color; store.set('pp-me', me); updatePresence() },
  }])
}
function serverDialog() {
  const inp = h('input', { class: 'field mono', id: 'srvUrl', placeholder: 'https://your-sync-server.example.com', value: serverUrl || '' })
  const err = h('p', { class: 'error small' })
  const st = net?.status()
  modal('Sync server', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'A sync server keeps an always-on copy of this workspace, so edits reach teammates even when nobody else is online. Everything is encrypted in your browser with the workspace key; the server cannot read your pages.'),
    h('label', { class: 'muted small', for: 'srvUrl' }, 'Server address (leave empty for peer-to-peer only)'),
    inp, err,
    st?.server ? h('p', { class: 'small' }, 'Status: ' + ({ connected: 'Connected', connecting: 'Connecting…', offline: 'Unreachable, retrying', error: st.serverError || 'Error' })[st.server]) : null),
  [{ label: 'Cancel' }, {
    label: 'Save', primary: true, run: () => {
      const v = inp.value.trim().replace(/\/+$/, '')
      if (v && !/^https?:\/\/[^\s]+$/.test(v)) { err.textContent = 'Enter a full address starting with https://'; return false }
      serverUrl = v || null
      srv = v || 'none'
      rememberWorkspace(meta.get('name') || 'Shared workspace')
      setHash(curId)
      location.reload()
    },
  }])
}
function linkRow(id, label, desc, edit) {
  const inp = h('input', { class: 'field mono', id, readonly: true, value: inviteLink(edit), 'aria-label': label })
  return h('div', { class: 'share-row' },
    h('div', { class: 'share-head' }, h('span', { class: 'role ' + (edit ? 'role-edit' : 'role-view') }, label), h('span', { class: 'muted small' }, desc)),
    h('div', { class: 'row' }, inp, h('button', { class: 'btn' + (edit ? ' primary' : ''), onclick: () => copy(inviteLink(edit), inp) }, 'Copy')))
}
$('#shareBtn').onclick = () => {
  const rows = []
  if (readOnly) {
    rows.push(h('p', { class: 'muted' }, 'You have view access, so you can only share a view-only link.'))
    rows.push(linkRow('inviteView', 'Can view', 'Read every page, no changes', false))
  } else if (pk) {
    rows.push(linkRow('inviteEdit', 'Can edit', 'Full access: write, rename, delete', true))
    rows.push(linkRow('inviteView', 'Can view', 'Read every page, no changes', false))
  } else {
    rows.push(linkRow('inviteEdit', 'Can edit', 'Full access: write, rename, delete', true))
    const upgrade = h('div', { class: 'upgrade' },
      h('p', { class: 'small' }, h('strong', {}, 'Want view-only links? '),
        serverUrl
          ? 'Turn on permissions for this workspace. Links shared before now will become view-only, so send editors the new edit link afterwards.'
          : 'This needs a sync server (workspace menu → Sync server…), so the server can block changes from view-only links.'),
      serverUrl ? h('button', { class: 'btn', id: 'upgradeBtn', onclick: async (e) => {
        e.currentTarget.disabled = true
        const keys = await generateWriteKeys()
        pk = keys.pk; sk = keys.sk
        rememberWorkspace(meta.get('name') || 'Shared workspace')
        setHash(curId)
        location.reload()
      } }, 'Turn on view-only links') : null)
    rows.push(upgrade)
  }
  modal('Share this workspace', h('div', { class: 'stack' }, ...rows,
    h('p', { class: 'muted small' }, 'Links contain the workspace key, so share them privately. Pages are encrypted with it; the sync server cannot read them.')), [{ label: 'Done' }])
}
$('#moreBtn').onclick = () => {
  if (!curId) return
  openMenu($('#moreBtn'), [
    { label: 'Copy page as Markdown', icon: '⧉', run: () => copy(toMarkdown(curId)) },
    { label: 'Export page (.md)', icon: '⤓', run: () => download(pageTitle(curId) + '.md', toMarkdown(curId)) },
    ...(readOnly ? [] : [
      { label: 'Add page inside', icon: '+', run: () => openPage(createPage(curId)) },
      { label: 'Import Markdown as page…', icon: '⤒', run: () => importMarkdown(curId) },
      { sep: true },
      { label: 'Delete page', icon: '🗑', danger: true, run: () => askDeletePage(curId) },
    ]),
  ])
}
function toMarkdown(id) {
  const head = `# ${pageIcon(id) ? pageIcon(id) + ' ' : ''}${pageTitle(id)}\n\n`
  return head + blocksToMarkdown(pages.get(id).get('blocks').toArray(), pageTitle) + '\n'
}
/** Import .md files as new pages (inside `parent`). The first "# Heading" becomes the title. */
function importMarkdown(parent) {
  const inp = h('input', { type: 'file', accept: '.md,.markdown,.txt,text/markdown,text/plain', multiple: true, hidden: true })
  inp.onchange = async () => {
    let last = null
    for (const f of inp.files) {
      const text = await f.text()
      const m = text.match(/^\s*#\s+(.+)\n?/)
      const title = m ? m[1].trim() : f.name.replace(/\.(md|markdown|txt)$/i, '')
      const specs = parseMarkdown(m ? text.slice(m[0].length) : text)
      last = createPage(parent, title, specs.length ? specs : [{}])
    }
    inp.remove()
    if (last) { openPage(last); toast(inp.files.length > 1 ? `Imported ${inp.files.length} pages` : 'Page imported') }
  }
  document.body.append(inp)
  inp.click()
}
function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/markdown' })), download: name.replace(/[\\/:*?"<>|]/g, '_') })
  document.body.append(a); a.click(); a.remove()
}

/* ---------------- presence ---------------- */
let net = null
let focusBlockId = null
function connected() { const s = net?.status(); return s && (s.p2p > 0 || s.server === 'connected' || [...net.peers.values()].some((p) => p.via === 'tab')) }
function setFocusBlock(id) { focusBlockId = id; updatePresence() }
function updatePresence() { net?.setPresence({ name: me.name, color: me.color, page: curId, block: readOnly ? null : focusBlockId, role: readOnly ? 'view' : 'edit' }) }
function peersByPage() {
  const m = new Map()
  if (!net) return m
  for (const p of net.peers.values()) { if (!p.page) continue; if (!m.has(p.page)) m.set(p.page, []); m.get(p.page).push(p) }
  return m
}
function renderPeerMarks() {
  if (!cur || !net) return
  const byBlock = new Map()
  for (const p of net.peers.values()) if (p.page === curId && p.block) byBlock.set(p.block, p)
  for (const n of cur.nodes.values()) {
    const p = byBlock.get(n.bm.get('id'))
    n.el.classList.toggle('peer', !!p)
    if (p) { n.el.style.setProperty('--peer', p.color); n.el.dataset.peer = p.name } else delete n.el.dataset.peer
  }
}
function renderPeople() {
  const people = $('#people')
  people.innerHTML = ''
  const face = (p, you) => h('span', { class: 'avatar', style: `background:${p.color}`, title: p.name }, (p.name || '?')[0].toUpperCase())
  people.append(h('button', { class: 'person', onclick: profileDialog, title: 'Change your name' }, face(me), h('span', { class: 'txt' }, me.name, h('span', { class: 'muted' }, readOnly ? ' (you, viewing)' : ' (you)'))))
  const faces = $('#faces')
  faces.innerHTML = ''
  for (const p of net.peers.values()) {
    people.append(h('button', { class: 'person', onclick: () => p.page && openPage(p.page) }, face(p),
      h('span', { class: 'txt' }, p.name || 'Anonymous', h('span', { class: 'muted small sub' }, (p.role === 'view' ? 'viewing ' : 'on ') + (p.page ? pageTitle(p.page) : 'nothing')))))
    if (p.page === curId) faces.append(face(p))
  }
  const st = net.status()
  const n = net.peers.size
  const online = n ? ` · ${n} other${n > 1 ? 's' : ''} online` : ''
  let cls, text
  if (st.server === 'connected') { cls = 'on'; text = 'Saved to sync server' + online }
  else if (st.p2p) { cls = 'on'; text = `Connected to ${st.p2p} peer${st.p2p > 1 ? 's' : ''}` + (st.server ? ' · server unreachable' : '') }
  else if (st.server === 'connecting') { cls = 'wait'; text = 'Connecting to sync server…' }
  else if (st.server) { cls = 'err'; text = (st.serverError || 'Sync server unreachable') + ' Edits are saved offline.' }
  else if (n) { cls = 'on'; text = 'Connected (this browser only)' }
  else { cls = st.error ? 'err' : 'wait'; text = st.error ? 'Peer discovery failed. Working offline.' : 'Looking for peers… (edits saved offline)' }
  $('#net').className = 'net ' + cls
  $('#net').textContent = text
}

/* ---------------- read-only mode ---------------- */
function applyReadOnly() {
  document.body.classList.toggle('read-only', readOnly)
  $('#roBadge').hidden = !readOnly
  const t = $('.title')
  if (t) t.readOnly = readOnly
  if (cur) renderBlocks()
  updatePresence()
}

/* ---------------- boot ---------------- */
;(async () => {
  const hadLocal = await loadLocal(doc, ws)
  if (!hadLocal && createdHere && !pages.size) seedWorkspace()
  // If this page was served by a PeerPad sync server, use it automatically.
  if (location.protocol.startsWith('http')) {
    try {
      const r = await fetch(new URL('peerpad-health', location.href), { cache: 'no-store' })
      if (r.ok && (await r.json()).peerpad) {
        servedByServer = true
        if (!serverUrl && srv !== 'none') serverUrl = new URL('.', location.href).href.replace(/\/+$/, '')
      }
    } catch {}
  }
  if (servedByServer && serverUrl === new URL('.', location.href).href.replace(/\/+$/, '')) setHash(params().get('p'))
  if (createdHere && !pk) { const k = await generateWriteKeys(); pk = k.pk; sk = k.sk; setHash(params().get('p')) }
  const signer = await loadSigner(pk, sk).catch(() => null)
  if (pk && !signer?.canWrite) { readOnly = true; sk = null }
  applyReadOnly()
  net = connect(doc, ws, key, serverUrl, signer)
  net.onChange(() => {
    if (net.status().readOnly !== readOnly) { readOnly = net.status().readOnly; applyReadOnly() }
    renderPeople(); renderPeerMarks(); renderSidebarSoon()
  })
  renderPeople()
  setInterval(renderPeople, 5000)
  openPage(params().get('p') || children(null)[0])
})()
