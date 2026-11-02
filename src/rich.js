// Rich blocks for the editor: inline formatting, images, tables, charts, table of contents.
import * as Y from 'yjs'
import { parseNumber } from './model.js'

/* ---------------- inline formatting: **bold** *italic* `code` ~~strike~~ [link](url) ---------------- */
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c])
export const hasMarkup = (s) => /\*\*|__|`|~~|\[[^\]]+\]\([^)]+\)|(^|[^*\w])\*[^*\s]/.test(s)
export function renderInline(src) {
  const codes = []
  let s = String(src).replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
  s = esc(s)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, u) => {
    const url = u.replace(/&amp;/g, '&')
    if (!/^(https?:|mailto:)/i.test(url)) return m
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`
  })
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '$1<em>$2</em>')
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`)
}
/** Wrap the textarea selection in markers (or unwrap if already wrapped). */
export function wrapSelection(ta, before, after = before, placeholder = '') {
  const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value
  const sel = v.slice(s, e) || placeholder
  if (v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) {
    ta.setRangeText(sel, s - before.length, e + after.length, 'select')
  } else {
    ta.setRangeText(before + sel + after, s, e)
    ta.setSelectionRange(s + before.length, s + before.length + sel.length)
  }
  ta.dispatchEvent(new Event('input'))
}

/* ---------------- images ---------------- */
/** Shrink large photos before upload (keeps GIF/SVG, and the original if it is already smaller). */
export async function processImage(file) {
  const orig = new Uint8Array(await file.arrayBuffer())
  if (!/^image\/(png|jpe?g|webp|bmp)$/.test(file.type)) return { bytes: orig, mime: file.type || 'image/png' }
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height))
    const c = document.createElement('canvas')
    c.width = Math.round(bmp.width * scale)
    c.height = Math.round(bmp.height * scale)
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
    const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.9))
    if (blob && blob.size < orig.length) return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/webp' }
  } catch {}
  return { bytes: orig, mime: file.type }
}
const assetUrls = new Map() // asset id -> Promise<object URL>
function assetObjectUrl(ctx, id, mime) {
  if (!assetUrls.has(id)) {
    const p = (async () => {
      const a = ctx.assets()
      if (!a) throw new Error('Connect a sync server to see this image.')
      const bytes = await a.fetch(id)
      return URL.createObjectURL(new Blob([bytes], { type: mime || 'image/webp' }))
    })()
    p.catch(() => assetUrls.delete(id))
    assetUrls.set(id, p)
  }
  return assetUrls.get(id)
}

export function imageBlock(ctx, bm, body, ta) {
  const img = h('img', { class: 'img', alt: '', draggable: 'false' })
  const status = h('div', { class: 'img-status' })
  const figure = h('figure', { class: 'figure' }, img, status)
  body.prepend(figure)
  ta.classList.add('caption')
  let shown = null
  async function load() {
    const key = bm.get('url') || bm.get('asset') || (bm.get('data') ? 'inline' : '')
    if (key === shown) return
    shown = key
    img.removeAttribute('src')
    status.textContent = ''
    try {
      if (bm.get('url')) img.src = bm.get('url')
      else if (bm.get('data')) img.src = URL.createObjectURL(new Blob([bm.get('data')], { type: bm.get('mime') || 'image/png' }))
      else if (bm.get('asset')) {
        status.textContent = 'Loading image…'
        img.src = await assetObjectUrl(ctx, bm.get('asset'), bm.get('mime'))
        status.textContent = ''
      } else status.textContent = 'No image'
    } catch (e) {
      status.textContent = e.message
      shown = null
    }
  }
  img.onerror = () => { if (img.getAttribute('src')) status.textContent = 'This image could not be loaded.' }
  img.alt = bm.get('text')?.toString() || 'Image'
  return {
    update() {
      figure.style.width = (bm.get('width') || 100) + '%'
      ta.placeholder = 'Add a caption'
      img.alt = bm.get('text')?.toString() || 'Image'
      load()
    },
    src: () => img.getAttribute('src'),
    cleanup() {},
  }
}

/* ---------------- tables (also the data editor for charts) ---------------- */
function grid(ctx, bm, host, { header = true, onFocusCell, headPlaceholder = (c) => `Column ${c + 1}` } = {}) {
  const table = h('table', { class: 'tbl' + (header ? ' has-head' : '') })
  host.append(h('div', { class: 'table-wrap' }, table))
  let cleanups = []
  let focus = null // { r, c, restore }
  const rowsRef = bm.get('rows') // keep a reference: a deleted block no longer returns it
  const rowsY = () => bm.get('rows') || rowsRef

  function addRow(at) {
    const cols = rowsY().get(0)?.length || 1
    const ra = new Y.Array()
    ra.push(Array.from({ length: cols }, () => new Y.Text('')))
    ctx.transact(() => rowsY().insert(at ?? rowsY().length, [ra]))
  }
  function addCol(at) {
    ctx.transact(() => rowsY().forEach((ra) => ra.insert(at ?? ra.length, [new Y.Text('')])))
  }
  function delRow(r) { if (rowsY().length > 1) ctx.transact(() => rowsY().delete(r, 1)) }
  function delCol(c) { if ((rowsY().get(0)?.length || 0) > 1) ctx.transact(() => rowsY().forEach((ra) => ra.delete(c, 1))) }
  function focusCell(r, c, pos = 'end') {
    const ta = table.rows[r]?.cells[c]?.querySelector('textarea')
    if (!ta) return false
    ta.focus()
    const p = pos === 'end' ? ta.value.length : 0
    ta.setSelectionRange(p, p)
    return true
  }

  function render() {
    cleanups.forEach((f) => f())
    cleanups = []
    table.innerHTML = ''
    rowsY().toArray().forEach((ra, r) => {
      const tr = h('tr')
      ra.toArray().forEach((yt, c) => {
        const ta = h('textarea', { class: 'cell', rows: 1, 'aria-label': `Row ${r + 1}, column ${c + 1}`, placeholder: header && r === 0 ? headPlaceholder(c) : '' })
        ta.readOnly = ctx.readOnly()
        cleanups.push(ctx.bindText(ta, yt))
        ta.addEventListener('input', () => { ctx.applyDiff(yt, ta.value, ta); ctx.autosize(ta) })
        ta.addEventListener('focus', () => { focus = { r, c }; ctx.onFocus(); onFocusCell?.(r, c) })
        ta.addEventListener('keydown', (e) => cellKey(e, ta, r, c))
        tr.append(h(header && r === 0 ? 'th' : 'td', {}, ta))
        requestAnimationFrame(() => ctx.autosize(ta))
      })
      table.append(tr)
    })
    if (focus && host.contains(document.activeElement) === false && focus.restore) {
      focusCell(Math.min(focus.r, table.rows.length - 1), focus.c)
      focus.restore = false
    }
  }
  function cellKey(e, ta, r, c) {
    if (ctx.readOnly()) return
    const rows = table.rows.length, cols = table.rows[0]?.cells.length || 0
    if (e.key === 'Tab') {
      e.preventDefault()
      let nr = r, nc = c + (e.shiftKey ? -1 : 1)
      if (nc >= cols) { nc = 0; nr++ }
      if (nc < 0) { nc = cols - 1; nr-- }
      if (nr < 0) return
      if (nr >= rows) { focus = { r: nr, c: 0, restore: true }; addRow() }
      focusCell(nr, nc, 'start')
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (r + 1 >= rows) { focus = { r: r + 1, c, restore: true }; addRow() }
      focusCell(r + 1, c)
    } else if (e.key === 'ArrowUp' && ta.selectionStart === 0 && r > 0) { e.preventDefault(); focusCell(r - 1, c) }
    else if (e.key === 'ArrowDown' && ta.selectionEnd === ta.value.length && r + 1 < rows) { e.preventDefault(); focusCell(r + 1, c) }
  }
  const obs = (events) => {
    if (events.every((ev) => ev.target instanceof Y.Text)) return
    const had = document.activeElement && table.contains(document.activeElement)
    if (had && focus) focus.restore = true
    render()
  }
  rowsY().observeDeep(obs)
  render()
  return {
    addRow, addCol, delRow, delCol, focusCell,
    focused: () => focus,
    cleanup() { cleanups.forEach((f) => f()); rowsRef.unobserveDeep(obs) },
  }
}

export function tableBlock(ctx, bm, body) {
  const g = grid(ctx, bm, body)
  const btn = (label, title, fn) => h('button', { class: 'tool', title, onclick: fn }, label)
  const at = () => g.focused() || { r: bm.get('rows').length - 1, c: bm.get('rows').get(0).length - 1 }
  body.append(h('div', { class: 'table-tools needs-edit' },
    btn('+ Row', 'Add a row below the selected cell', () => g.addRow(at().r + 1)),
    btn('+ Column', 'Add a column right of the selected cell', () => g.addCol(at().c + 1)),
    btn('− Row', 'Delete the selected row', () => g.delRow(at().r)),
    btn('− Column', 'Delete the selected column', () => g.delCol(at().c))))
  return { update() {}, focusFirst: () => g.focusCell(0, 0), cleanup: g.cleanup }
}

/* ---------------- charts ---------------- */
const fmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
function niceStep(range, target = 4) {
  const raw = range / target
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)))
  const n = raw / mag
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag
}
const SVGNS = 'http://www.w3.org/2000/svg'
const s = (tag, attrs = {}, text) => {
  const el = document.createElementNS(SVGNS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  if (text != null) el.textContent = text
  return el
}

export function drawChart(svg, rows, kind) {
  svg.innerHTML = ''
  const head = rows[0] || []
  const body = rows.slice(1).filter((r) => r.some((c) => String(c).trim()))
  const labels = body.map((r) => r[0] ?? '')
  const series = head.slice(1).map((name, j) => ({ name: name || `Series ${j + 1}`, raw: body.map((r) => r[j + 1] ?? ''), values: body.map((r) => parseNumber(r[j + 1])) }))
    .filter((se) => se.values.some(Number.isFinite))
  const W = 640, H = 300, L = 56, R = 16, T = 14, B = series.length > 1 ? 58 : 34
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  if (!labels.length || !series.length) {
    svg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'ch-empty' }, 'Add numbers in the data table to draw the chart'))
    return
  }
  // unit prefix/suffix from the data ("$", "%")
  const sample = series[0].raw.find((v) => String(v).trim()) || ''
  const prefix = (String(sample).match(/^[^\d\-.]+/) || [''])[0].trim()
  const suffix = /%\s*$/.test(sample) ? '%' : ''
  const label = (v) => prefix + fmt.format(v) + suffix
  const all = series.flatMap((se) => se.values.filter(Number.isFinite))
  let min = Math.min(0, ...all), max = Math.max(0, ...all)
  if (max === min) max = min + 1
  const step = niceStep(max - min)
  min = Math.floor(min / step) * step
  max = Math.ceil(max / step) * step
  const pw = W - L - R, ph = H - T - B
  const y = (v) => T + ph - ((v - min) / (max - min)) * ph
  // grid + y labels
  for (let v = min; v <= max + step / 2; v += step) {
    svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? 'ch-axis' : 'ch-grid' }))
    svg.append(s('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'ch-label' }, label(v)))
  }
  const band = pw / labels.length
  const every = Math.ceil(labels.length / Math.max(1, Math.floor(pw / 70)))
  labels.forEach((lb, i) => {
    if (i % every) return
    const t = String(lb).length > 12 ? String(lb).slice(0, 11) + '…' : lb
    svg.append(s('text', { x: L + band * i + band / 2, y: T + ph + 18, 'text-anchor': 'middle', class: 'ch-label' }, t))
  })
  series.forEach((se, j) => {
    const color = `var(--chart-${(j % 4) + 1})`
    if (kind === 'line') {
      const pts = se.values.map((v, i) => (Number.isFinite(v) ? [L + band * i + band / 2, y(v)] : null)).filter(Boolean)
      svg.append(s('path', { d: pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' '), class: 'ch-line', style: `stroke:${color}` }))
      se.values.forEach((v, i) => {
        if (!Number.isFinite(v)) return
        const c = s('circle', { cx: L + band * i + band / 2, cy: y(v), r: 3.5, class: 'ch-dot', style: `fill:${color}` })
        c.append(s('title', {}, `${labels[i]} · ${se.name}: ${se.raw[i]}`))
        svg.append(c)
      })
    } else {
      const gw = band * 0.72, bw = gw / series.length
      se.values.forEach((v, i) => {
        if (!Number.isFinite(v)) return
        const x = L + band * i + (band - gw) / 2 + bw * j
        const y0 = y(Math.max(0, v)), hgt = Math.max(1, Math.abs(y(v) - y(0)))
        const r = s('rect', { x: x + 1, y: y0, width: Math.max(1, bw - 2), height: hgt, rx: Math.min(4, bw / 4), class: 'ch-bar', style: `fill:${color}` })
        r.append(s('title', {}, `${labels[i]} · ${se.name}: ${se.raw[i]}`))
        svg.append(r)
      })
    }
  })
  if (series.length > 1) {
    let x = L
    series.forEach((se, j) => {
      svg.append(s('rect', { x, y: H - 18, width: 10, height: 10, rx: 2, style: `fill:var(--chart-${(j % 4) + 1})` }))
      const t = s('text', { x: x + 15, y: H - 9, class: 'ch-label' }, se.name)
      svg.append(t)
      x += 30 + se.name.length * 7
    })
  }
}

export function chartBlock(ctx, bm, body, ta) {
  ta.classList.add('chart-title')
  const svg = document.createElementNS(SVGNS, 'svg')
  svg.setAttribute('class', 'chart')
  svg.setAttribute('role', 'img')
  const dataHost = h('div', { class: 'chart-data', hidden: true })
  const toggle = h('button', { class: 'tool', onclick: () => { dataHost.hidden = !dataHost.hidden; toggle.textContent = dataHost.hidden ? 'Edit data' : 'Hide data' } }, 'Edit data')
  const kindBtn = h('button', { class: 'tool', onclick: () => ctx.transact(() => bm.set('chart', bm.get('chart') === 'line' ? 'bar' : 'line')) })
  body.append(svg, h('div', { class: 'table-tools needs-edit' }, toggle, kindBtn), dataHost)
  const g = grid(ctx, bm, dataHost, { headPlaceholder: (c) => (c ? `Series ${c}` : 'Label') })
  const btn = (label, fn) => h('button', { class: 'tool', onclick: fn }, label)
  dataHost.append(h('div', { class: 'table-tools' },
    btn('+ Row', () => g.addRow()), btn('+ Series', () => g.addCol()),
    btn('− Row', () => g.delRow(g.focused()?.r ?? bm.get('rows').length - 1)),
    btn('− Series', () => g.delCol(Math.max(1, g.focused()?.c ?? 1)))),
    h('p', { class: 'hint' }, 'First column: labels. Other columns: one series each. Values like $35.9B, 1,200 or 12% work.'))
  const redraw = () => {
    const rows = rowsRef.toArray().map((r) => r.toArray().map((t) => t.toString()))
    drawChart(svg, rows, bm.get('chart'))
    svg.setAttribute('aria-label', (bm.get('text')?.toString() || 'Chart') + ': ' + rows.slice(1).map((r) => r.join(' ')).join('; '))
  }
  let q = false
  const obs = () => { if (!q) { q = true; requestAnimationFrame(() => { q = false; redraw() }) } }
  const rowsRef = bm.get('rows')
  rowsRef.observeDeep(obs)
  return {
    update() {
      ta.placeholder = 'Chart title'
      kindBtn.textContent = bm.get('chart') === 'line' ? 'Show as bars' : 'Show as line'
      redraw()
    },
    showData() { dataHost.hidden = false; toggle.textContent = 'Hide data'; g.focusCell(1, 0) },
    cleanup() { rowsRef.unobserveDeep(obs); g.cleanup() },
  }
}

/* ---------------- table of contents ---------------- */
export function tocBlock(ctx, bm, body) {
  const nav = h('nav', { class: 'toc', 'aria-label': 'Table of contents' })
  body.append(nav)
  return {
    update() {
      nav.innerHTML = ''
      const heads = ctx.headings()
      if (!heads.length) nav.append(h('p', { class: 'hint' }, 'Add headings to this page and they will be listed here.'))
      for (const hd of heads) {
        nav.append(h('button', { class: 'toc-item lvl-' + hd.type, onclick: () => ctx.scrollToBlock(hd.bm) }, hd.text.replace(/[*_`~]/g, '') || 'Untitled heading'))
      }
    },
    cleanup() {},
  }
}

/* small DOM helper (same shape as main.js) */
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
