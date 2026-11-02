'use client'
import { useMemo, useState } from 'react'
import { createReactBlockSpec } from '@blocknote/react'
import { AnimatePresence, motion } from 'motion/react'
import { BarChart3, LineChart, Table2, Plus, Minus } from 'lucide-react'
import { chartConfig, parseRows } from '@/lib/blocks.ts'

/** "$35.9B" -> 35.9e9, "1,234" -> 1234, "12%" -> 12; NaN if not a number. */
export function parseNumber(s: string): number {
  const m = String(s).replace(/[,\s]/g, '').match(/^[^\d\-.]*(-?\d*\.?\d+)([kKmMbBtT]?)/)
  if (!m) return NaN
  const mult = ({ k: 1e3, m: 1e6, b: 1e9, t: 1e12 } as Record<string, number>)[m[2].toLowerCase()] || 1
  return parseFloat(m[1]) * mult
}
const fmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
function niceStep(range: number, target = 4) {
  const raw = range / target
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)))
  const n = raw / mag
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag
}

export function ChartSvg({ rows, kind }: { rows: string[][]; kind: 'bar' | 'line' }) {
  const W = 640, H = 300, L = 56, R = 16, T = 14
  const model = useMemo(() => {
    const head = rows[0] || []
    const body = rows.slice(1).filter((r) => r.some((c) => String(c).trim()))
    const labels = body.map((r) => r[0] ?? '')
    const series = head.slice(1).map((name, j) => ({ name: name || `Series ${j + 1}`, raw: body.map((r) => r[j + 1] ?? ''), values: body.map((r) => parseNumber(r[j + 1] ?? '')) }))
      .filter((s) => s.values.some(Number.isFinite))
    return { labels, series }
  }, [rows])
  const { labels, series } = model
  const B = series.length > 1 ? 58 : 34
  if (!labels.length || !series.length) {
    return <div className="grid h-40 place-items-center rounded-lg border border-dashed border-line text-sm text-muted">Add numbers in the data table to draw the chart</div>
  }
  const sample = series[0].raw.find((v) => String(v).trim()) || ''
  const prefix = (String(sample).match(/^[^\d\-.]+/) || [''])[0].trim()
  const suffix = /%\s*$/.test(sample) ? '%' : ''
  const label = (v: number) => prefix + fmt.format(v) + suffix
  const all = series.flatMap((s) => s.values.filter(Number.isFinite))
  let min = Math.min(0, ...all), max = Math.max(0, ...all)
  if (max === min) max = min + 1
  const step = niceStep(max - min)
  min = Math.floor(min / step) * step
  max = Math.ceil(max / step) * step
  const pw = W - L - R, ph = H - T - B
  const y = (v: number) => T + ph - ((v - min) / (max - min)) * ph
  const band = pw / labels.length
  const every = Math.ceil(labels.length / Math.max(1, Math.floor(pw / 70)))
  const ticks: number[] = []
  for (let v = min; v <= max + step / 2; v += step) ticks.push(v)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-visible" role="img"
      aria-label={labels.map((l, i) => `${l}: ${series.map((s) => s.raw[i]).join(', ')}`).join('; ')}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className={v === 0 ? 'ch-axis' : 'ch-grid'} />
          <text x={L - 8} y={y(v) + 4} textAnchor="end" className="ch-label">{label(v)}</text>
        </g>
      ))}
      {labels.map((lb, i) => i % every ? null : (
        <text key={i} x={L + band * i + band / 2} y={T + ph + 18} textAnchor="middle" className="ch-label">
          {String(lb).length > 12 ? String(lb).slice(0, 11) + '…' : lb}
        </text>
      ))}
      {series.map((s, j) => {
        const color = `var(--chart-${(j % 4) + 1})`
        if (kind === 'line') {
          const pts = s.values.map((v, i) => (Number.isFinite(v) ? [L + band * i + band / 2, y(v)] : null)).filter(Boolean) as number[][]
          return (
            <g key={j}>
              <motion.path d={pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')} className="ch-line" style={{ stroke: color }}
                initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.6, ease: 'easeOut' }} />
              {s.values.map((v, i) => Number.isFinite(v) && (
                <circle key={i} cx={L + band * i + band / 2} cy={y(v)} r={3.5} className="ch-dot" style={{ fill: color }}>
                  <title>{`${labels[i]} · ${s.name}: ${s.raw[i]}`}</title>
                </circle>
              ))}
            </g>
          )
        }
        const gw = band * 0.72, bw = gw / series.length
        return (
          <g key={j}>
            {s.values.map((v, i) => {
              if (!Number.isFinite(v)) return null
              const x = L + band * i + (band - gw) / 2 + bw * j
              const top = y(Math.max(0, v)), hgt = Math.max(1, Math.abs(y(v) - y(0)))
              return (
                <motion.rect key={i} x={x + 1} width={Math.max(1, bw - 2)} rx={Math.min(4, bw / 4)} style={{ fill: color, originY: 1 }}
                  initial={{ y: y(0), height: 0 }} animate={{ y: top, height: hgt }} transition={{ type: 'spring', stiffness: 160, damping: 22, delay: i * 0.03 }}
                  className="transition-opacity hover:opacity-80">
                  <title>{`${labels[i]} · ${s.name}: ${s.raw[i]}`}</title>
                </motion.rect>
              )
            })}
          </g>
        )
      })}
      {series.length > 1 && (() => {
        let x = L
        return series.map((s, j) => {
          const el = (
            <g key={j}>
              <rect x={x} y={H - 18} width={10} height={10} rx={2} style={{ fill: `var(--chart-${(j % 4) + 1})` }} />
              <text x={x + 15} y={H - 9} className="ch-label">{s.name}</text>
            </g>
          )
          x += 30 + s.name.length * 7
          return el
        })
      })()}
    </svg>
  )
}

function DataGrid({ rows, onChange }: { rows: string[][]; onChange: (rows: string[][]) => void }) {
  const cols = Math.max(1, ...rows.map((r) => r.length))
  const set = (r: number, c: number, v: string) => onChange(rows.map((row, i) => (i === r ? Array.from({ length: cols }, (_, j) => (j === c ? v : row[j] ?? '')) : row)))
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-[13px]">
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className={r === 0 ? 'bg-sidebar font-semibold' : ''}>
                {Array.from({ length: cols }, (_, c) => (
                  <td key={c} className="min-w-[96px] border-b border-r border-line last:border-r-0">
                    <input
                      value={row[c] ?? ''} onChange={(e) => set(r, c, e.target.value)}
                      placeholder={r === 0 ? (c ? `Series ${c}` : 'Label') : ''}
                      aria-label={`Row ${r + 1}, column ${c + 1}`}
                      className="w-full bg-transparent px-2.5 py-1.5 outline-none placeholder:text-faint focus:bg-accent-soft"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <GridBtn onClick={() => onChange([...rows, Array(cols).fill('')])}><Plus size={12} /> Row</GridBtn>
        <GridBtn onClick={() => onChange(rows.map((r, i) => [...r, i === 0 ? `Series ${cols}` : '']))}><Plus size={12} /> Series</GridBtn>
        <GridBtn onClick={() => rows.length > 2 && onChange(rows.slice(0, -1))}><Minus size={12} /> Row</GridBtn>
        <GridBtn onClick={() => cols > 2 && onChange(rows.map((r) => r.slice(0, cols - 1)))}><Minus size={12} /> Series</GridBtn>
        <span className="ml-auto self-center text-xs text-faint">First column: labels. Values like $35.9B, 1,200 or 12% work.</span>
      </div>
    </div>
  )
}
const GridBtn = (p: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button {...p} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-muted transition hover:bg-hover hover:text-fg" />
)

export const ChartBlock = createReactBlockSpec(chartConfig as any, {
  render: ({ block, editor }: any) => {
    const [showData, setShowData] = useState(false)
    const rows = parseRows(block.props.data)
    const editable = editor.isEditable
    const update = (props: Record<string, string>) => editor.updateBlock(block, { props })
    return (
      <div className="group/chart my-1 w-full rounded-xl border border-line bg-surface p-4" contentEditable={false}>
        <div className="mb-2 flex items-center gap-2">
          {editable ? (
            <input value={block.props.title} onChange={(e) => update({ title: e.target.value })} placeholder="Chart title"
              className="min-w-0 flex-1 bg-transparent text-[15px] font-semibold outline-none placeholder:text-faint" />
          ) : (
            <div className="flex-1 text-[15px] font-semibold">{block.props.title}</div>
          )}
          {editable && (
            <div className="flex gap-1 opacity-0 transition-opacity group-hover/chart:opacity-100 focus-within:opacity-100">
              <IconToggle active={block.props.chartType === 'bar'} label="Bar chart" onClick={() => update({ chartType: 'bar' })}><BarChart3 size={15} /></IconToggle>
              <IconToggle active={block.props.chartType === 'line'} label="Line chart" onClick={() => update({ chartType: 'line' })}><LineChart size={15} /></IconToggle>
              <IconToggle active={showData} label="Edit data" onClick={() => setShowData((s) => !s)}><Table2 size={15} /></IconToggle>
            </div>
          )}
        </div>
        <ChartSvg rows={rows} kind={block.props.chartType === 'line' ? 'line' : 'bar'} />
        <AnimatePresence initial={false}>
          {editable && showData && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <div className="pt-3"><DataGrid rows={rows} onChange={(r) => update({ data: JSON.stringify(r) })} /></div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  },
})
function IconToggle({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={label} aria-label={label} aria-pressed={active} onClick={onClick}
      className={`grid size-7 place-items-center rounded-md transition ${active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-fg'}`}>
      {children}
    </button>
  )
}
