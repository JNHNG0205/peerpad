import * as Y from 'yjs'
import { connect, loadLocal } from './sync.js'
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
let { ws, key, createdHere, srv } = (() => {
  const p = params()
  const recent = store.get('pp-recent', [])
  if (p.get('ws') && p.get('key')) {
    const known = recent.find((w) => w.ws === p.get('ws'))
    return { ws: p.get('ws'), key: p.get('key'), createdHere: !!p.get('new'), srv: p.get('srv') || known?.srv || null }
  }
  if (recent[0]) return { ws: recent[0].ws, key: recent[0].key, createdHere: false, srv: recent[0].srv || null }
  return { ws: randToken(9), key: randToken(16), createdHere: true, srv: null }
})()
// The sync server that served this page is used automatically; "none" = explicitly disabled.
let serverUrl = srv && srv !== 'none' ? srv : null
const setHash = (page) => {
  const p = new URLSearchParams({ ws, key })
  if (serverUrl) p.set('srv', serverUrl)
  if (page) p.set('p', page)
  history.replaceState(null, '', '#' + p.toString())
}
setHash(params().get('p'))
addEventListener('hashchange', () => {
  const p = params()
  if (p.get('ws') !== ws) location.reload()
  else if (p.get('p') && p.get('p') !== curId) openPage(p.get('p'))
})
const inviteLink = () => {
  const p = new URLSearchParams({ ws, key })
  if (serverUrl && !servedByServer) p.set('srv', serverUrl)
  const base = servedByServer ? serverUrl.replace(/\/+$/, '') + '/' : location.href.split('#')[0]
  return base + '#' + p.toString()
}
let servedByServer = false

function newWorkspace() {
  location.hash = `ws=${randToken(9)}&key=${randToken(16)}&new=1` + (serverUrl ? '&srv=' + encodeURIComponent(serverUrl) : '')
}

/* ---------------- doc ---------------- */
const doc = new Y.Doc()
const meta = doc.getMap('meta')
const pages = doc.getMap('pages')
const undo = new Y.UndoManager(pages, { trackedOrigins: new Set(['local', HTMLTextAreaElement]), captureTimeout: 400 })

function makeBlock({ type = 'p', text = '', checked = false, indent = 0, ref = null } = {}) {
  const m = new Y.Map()
  m.set('id', uid())
  m.set('type', type)
  m.set('text', new Y.Text(text))
  m.set('checked', checked)
  m.set('indent', indent)
  if (ref) m.set('ref', ref)
  return m
}
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
    h('button', { class: 'new-page', onclick: () => openPage(createPage(null)) }, '+ New page'),
    h('div', { class: 'side-label' }, 'People here'),
    h('div', { class: 'people', id: 'people' })),
  h('main', { class: 'main' },
    h('header', { class: 'top' },
      h('button', { class: 'icon-btn only-mobile', onclick: () => document.body.classList.add('nav-open'), 'aria-label': 'Open sidebar' }, '☰'),
      h('div', { class: 'crumbs', id: 'crumbs' }),
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
]
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
      h('button', { class: 'btn primary', onclick: () => openPage(createPage(null)) }, 'Create a page')))
    $('#crumbs').innerHTML = ''
    return
  }
  const map = pages.get(curId)
  const blocks = map.get('blocks')
  cur = { id: curId, map, blocks, nodes: new Map(), byMap: new WeakMap(), cleanups: [] }

  // icon
  const iconBtn = h('button', { class: 'page-icon' + (map.get('icon') ? '' : ' empty-icon'), title: 'Change icon' }, map.get('icon') || '+ Add icon')
  iconBtn.onclick = () => openMenuGrid(iconBtn)
  const iconObs = () => { iconBtn.textContent = map.get('icon') || '+ Add icon'; iconBtn.classList.toggle('empty-icon', !map.get('icon')) }
  map.observe(iconObs)
  cur.cleanups.push(() => map.unobserve(iconObs))

  // title
  const title = h('textarea', { class: 'title', rows: 1, placeholder: 'Untitled', spellcheck: 'true', 'aria-label': 'Page title' })
  cur.cleanups.push(bindText(title, map.get('title')))
  title.addEventListener('input', () => { applyDiff(map.get('title'), title.value.replace(/\n/g, ' '), title); autosize(title) })
  title.addEventListener('keydown', (e) => {
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
  if (!title.value) title.focus()
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
    if (i < 0 || arr[i] !== n.bm) { n.cleanup(); n.el.remove(); cur.nodes.delete(k) }
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
  const ta = n.ta
  ta.focus()
  const p = pos === 'end' ? ta.value.length : pos === 'start' ? 0 : pos
  ta.setSelectionRange(p, p)
}

function cloneBlock(bm) {
  return makeBlock({ type: bm.get('type'), text: bm.get('text').toString(), checked: bm.get('checked'), indent: bm.get('indent') || 0, ref: bm.get('ref') })
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

function turnInto(bm, type) {
  const i = idxOf(bm)
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

let dragFrom = -1
function createNode(bm) {
  const ta = h('textarea', { class: 'bt', rows: 1, spellcheck: 'true' })
  const check = h('input', { type: 'checkbox', class: 'chk', 'aria-label': 'Done' })
  const marker = h('div', { class: 'marker' }, check)
  const handle = h('button', { class: 'handle', draggable: 'true', title: 'Drag to move, click for options', 'aria-label': 'Block options' }, '⋮⋮')
  const link = h('button', { class: 'plink' })
  const el = h('div', { class: 'block' }, handle, h('div', { class: 'body' }, marker, ta, link))
  const unbind = bindText(ta, bm.get('text'))
  let slashAt = -1

  const n = {
    bm, el, ta,
    update(num) {
      const type = bm.get('type') || 'p'
      el.dataset.type = type
      marker.dataset.num = num ? num + '.' : ''
      el.style.setProperty('--indent', bm.get('indent') || 0)
      el.classList.toggle('done', !!bm.get('checked'))
      check.checked = !!bm.get('checked')
      ta.placeholder = T[type]?.ph || ''
      ta.readOnly = type === 'divider' || type === 'pagelink'
      if (type === 'pagelink') {
        const ref = bm.get('ref')
        link.textContent = pages.has(ref) ? (pageIcon(ref) || '📄') + '  ' + pageTitle(ref) : '⚠  Deleted page'
        link.classList.toggle('dead', !pages.has(ref))
      }
      requestAnimationFrame(() => autosize(ta))
    },
    cleanup() { unbind() },
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
      if (caret <= slashAt || /[\s/]/.test(q) || q.length > 16 || ta.value[slashAt] !== '/') { closeMenu(); slashAt = -1 }
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
    if (e.isComposing) return
    const type = bm.get('type')
    const i = idxOf(bm)
    const s = ta.selectionStart, en = ta.selectionEnd, text = ta.value
    const ind = bm.get('indent') || 0

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
      if (pt === 'divider' || pt === 'pagelink') {
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
    const i = idxOf(bm)
    openMenu(handle, [
      { heading: 'Turn into' },
      ...TYPES.filter((t) => t.type !== 'pagelink').map((t) => ({ ...t, run: () => turnInto(bm, t.type) })),
      { sep: true },
      { label: 'Duplicate', icon: '⧉', run: () => doc.transact(() => cur.blocks.insert(i + 1, [cloneBlock(bm)]), 'local') },
      { label: 'Move up', icon: '↑', run: () => i > 0 && moveBlock(i, i - 1) },
      { label: 'Move down', icon: '↓', run: () => moveBlock(i, i + 2) },
      { label: 'Delete', icon: '🗑', danger: true, run: () => doc.transact(() => { cur.blocks.delete(i, 1); if (!cur.blocks.length) cur.blocks.push([makeBlock()]) }, 'local') },
    ])
  })
  handle.addEventListener('dragstart', (e) => {
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

// Paste multi-line plain text as separate blocks.
document.addEventListener('paste', (e) => {
  const ta = e.target
  if (!cur || !(ta instanceof HTMLTextAreaElement) || !ta.classList.contains('bt')) return
  const text = e.clipboardData.getData('text/plain')
  const n = [...cur.nodes.values()].find((x) => x.ta === ta)
  if (!n || !text.includes('\n') || n.bm.get('type') === 'code') return
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

/* ---------------- undo / redo ---------------- */
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? undo.redo() : undo.undo() }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); undo.redo() }
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
      h('span', { class: 'acts' },
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
  list.unshift({ ws, key, name, srv: srv === 'none' ? 'none' : serverUrl, ts: Date.now() })
  store.set('pp-recent', list.slice(0, 12))
}
$('#wsSwitch').onclick = () => {
  const recent = store.get('pp-recent', [])
  openMenu($('#wsSwitch'), [
    { heading: 'Workspaces' },
    ...recent.map((w) => ({ label: w.name || 'Workspace', icon: w.ws === ws ? '✓' : '', run: () => { if (w.ws !== ws) location.hash = `ws=${w.ws}&key=${w.key}` + (w.srv ? '&srv=' + encodeURIComponent(w.srv) : '') } })),
    { sep: true },
    { label: 'Rename this workspace', icon: '✎', run: renameWorkspace },
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
      location.hash = `ws=${p.get('ws')}&key=${p.get('key')}` + (p.get('srv') ? '&srv=' + encodeURIComponent(p.get('srv')) : '')
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
$('#shareBtn').onclick = () => {
  const inp = h('input', { class: 'field mono', id: 'invite', readonly: true, value: inviteLink() })
  modal('Invite to this workspace', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Anyone with this link can read and edit every page. The key after "key=" encrypts the connection and never leaves your browsers.'),
    h('div', { class: 'row' }, inp, h('button', { class: 'btn primary', onclick: () => copy(inviteLink(), inp) }, 'Copy link')),
    h('p', { class: 'muted small' }, 'Sync is peer-to-peer: someone who has the latest changes must be online for others to receive them.')), [{ label: 'Done' }])
}
$('#moreBtn').onclick = () => {
  if (!curId) return
  openMenu($('#moreBtn'), [
    { label: 'Copy page as Markdown', icon: '⧉', run: () => copy(toMarkdown(curId)) },
    { label: 'Export page (.md)', icon: '⤓', run: () => download(pageTitle(curId) + '.md', toMarkdown(curId)) },
    { label: 'Add page inside', icon: '+', run: () => openPage(createPage(curId)) },
    { sep: true },
    { label: 'Delete page', icon: '🗑', danger: true, run: () => askDeletePage(curId) },
  ])
}
function toMarkdown(id) {
  const p = pages.get(id)
  const out = [`# ${pageIcon(id) ? pageIcon(id) + ' ' : ''}${pageTitle(id)}`, '']
  let n = 0
  for (const b of p.get('blocks').toArray()) {
    const t = b.get('text').toString(), pad = '  '.repeat(b.get('indent') || 0), type = b.get('type')
    n = type === 'number' ? n + 1 : 0
    out.push({
      h1: `# ${t}`, h2: `## ${t}`, h3: `### ${t}`, bullet: `${pad}- ${t}`, number: `${pad}${n}. ${t}`,
      todo: `${pad}- [${b.get('checked') ? 'x' : ' '}] ${t}`, quote: `> ${t}`, callout: `> 💡 ${t}`,
      code: '```\n' + t + '\n```', divider: '---', pagelink: `[${pageTitle(b.get('ref'))}]`,
    }[type] ?? `${pad}${t}`)
  }
  return out.join('\n') + '\n'
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
function updatePresence() { net?.setPresence({ name: me.name, color: me.color, page: curId, block: focusBlockId }) }
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
  people.append(h('button', { class: 'person', onclick: profileDialog, title: 'Change your name' }, face(me), h('span', { class: 'txt' }, me.name, h('span', { class: 'muted' }, ' (you)'))))
  const faces = $('#faces')
  faces.innerHTML = ''
  for (const p of net.peers.values()) {
    people.append(h('button', { class: 'person', onclick: () => p.page && openPage(p.page) }, face(p),
      h('span', { class: 'txt' }, p.name || 'Anonymous', h('span', { class: 'muted small sub' }, p.page ? 'on ' + pageTitle(p.page) : 'idle'))))
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
  net = connect(doc, ws, key, serverUrl)
  net.onChange(() => { renderPeople(); renderPeerMarks(); renderSidebarSoon() })
  renderPeople()
  setInterval(renderPeople, 5000)
  openPage(params().get('p') || children(null)[0])
})()
