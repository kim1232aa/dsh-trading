/**
 * 反转点标注 RevPoint v6.5 overlay. All logic lives in
 * tool-market/src/revpoint.ts (shared with market_snapshot); this file only draws.
 * calcParams: [细档%, 粗档%, pivot腿, 15m, 30m, 1H, 2H, 4H, 最少★]
 * extendData: provider derivative history (base-coin OI) for the OI1h star.
 */
import { revPoint, REVPOINT_HTF, starGlyphs, linePriceAt } from '../../../../tool-market/src/revpoint.js'
import type { RevPointResult, RpLine, RpTf } from '../../../../tool-market/src/revpoint.js'
import { formatPrice } from '../precision.js'

type K = { open: number; high: number; low: number; close: number; volume?: number; timestamp: number }
type Row = { rp?: RevPointResult }

export const REVPOINT_PARAM_DEFAULTS = [0.7, 2.0, 3, 0, 0, 1, 0, 1, 0]
const FONT = '11px system-ui, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif'

export function revPointRows(list: readonly K[], p: readonly number[], ext?: unknown): Row[] {
  const q = p.length === 9 ? p : REVPOINT_PARAM_DEFAULTS
  const hist = Array.isArray(ext) ? ext as { time: string; openInterest: number | null }[] : []
  const oi = hist.flatMap(h => (typeof h.openInterest === 'number' ? [{ t: Date.parse(h.time), oi: h.openInterest }] : []))
  const htf = Object.fromEntries(REVPOINT_HTF.map((d, i) => [d.key, q[3 + i] === 1])) as Record<RpTf, boolean>
  const rp = revPoint(list.map(k => ({ t: k.timestamp, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume ?? 0 })),
    oi, { thrPct: q[0]!, thrBigPct: q[1]!, pivotLeg: q[2]!, htf, minStars: q[8]!, fmt: formatPrice })
  const rows: Row[] = list.map(() => ({}))
  if (rows.length) rows[0] = { rp }
  return rows
}

const DASH: Record<RpLine['style'], number[]> = { solid: [], dotted: [2, 3], dashed: [6, 4] }

function label(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg: string, anchor: 'up' | 'down' | 'left') {
  const lines = text.split('\n')
  const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 10
  const h = lines.length * 14 + 4
  const bx = anchor === 'left' ? x + 4 : x - w / 2
  const by = anchor === 'down' ? y - h - 6 : anchor === 'up' ? y + 6 : y - h / 2
  ctx.fillStyle = bg
  ctx.fillRect(bx, by, w, h)
  ctx.fillStyle = fg
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  lines.forEach((l, i) => ctx.fillText(l, bx + 5, by + 3 + i * 14))
}

export const revPointIndicator = {
  name: 'REVPOINT',
  shortName: '反转点 RevPoint',
  series: 'price',
  calcParams: [...REVPOINT_PARAM_DEFAULTS],
  figures: [],
  calc: (list: K[], ind: { calcParams: number[]; extendData?: unknown }) => revPointRows(list, ind.calcParams, ind.extendData),
  createTooltipDataSource: ({ indicator, crosshair }: { indicator: { result: Row[] }; crosshair: { dataIndex?: number } }) => {
    const rp = indicator.result?.[0]?.rp
    const i = crosshair.dataIndex
    const hits = rp && i !== undefined ? [
      ...rp.fine.filter(f => f.idx === i).map(f => ({ title: f.isTop ? '顶 ' : '底 ', value: { text: f.tip, color: f.isTop ? '#f47067' : '#3ddc97' } })),
      ...rp.big.filter(b => b.idx === i).map(b => ({ title: '', value: { text: b.text.replace('\n', ' '), color: '#d29922' } })),
      ...rp.cBars.filter(b => b.idx === i).map(b => ({ title: '', value: { text: b.text, color: '#a371f7' } })),
    ] : []
    return { calcParamsText: '', values: hits, icons: [] }
  },
  draw: ({ ctx, indicator, xAxis, yAxis, bounding, kLineDataList }: {
    ctx: CanvasRenderingContext2D
    indicator: { result: Row[] }
    xAxis: { convertToPixel: (v: number) => number }
    yAxis: { convertToPixel: (v: number) => number }
    bounding: { width: number; height: number }
    kLineDataList: K[]
  }) => {
    const rp = indicator.result?.[0]?.rp
    if (!rp) return false
    const X = (i: number) => xAxis.convertToPixel(i)
    const Y = (v: number) => yAxis.convertToPixel(v)
    const idxOfT = (t: number) => { let k = 0; for (let j = 0; j < kLineDataList.length; j++) if (kLineDataList[j]!.timestamp <= t) k = j; return k }
    const right = bounding.width
    ctx.save()
    ctx.font = FONT
    // swing trendlines
    for (const l of [rp.lines.fineUp, rp.lines.fineDn, rp.lines.upLn, rp.lines.dnLn]) {
      if (!l) continue
      ctx.strokeStyle = l.color; ctx.lineWidth = l.width; ctx.setLineDash(DASH[l.style])
      ctx.beginPath(); ctx.moveTo(X(l.x1), Y(l.y1))
      if (l.extend) { const xe = kLineDataList.length + 50; ctx.lineTo(X(xe), Y(linePriceAt(l, xe))) } else ctx.lineTo(X(l.x2), Y(l.y2))
      ctx.stroke()
    }
    ctx.setLineDash([])
    // HTF levels
    for (const h of rp.htf) {
      if (!h.on) continue
      for (const [lv, isRes] of [[h.r, true], [h.s, false]] as const) {
        const col = isRes ? h.color.r : h.color.s
        if (lv.active) {
          ctx.strokeStyle = col; ctx.lineWidth = h.tf === '4H' ? 3 : h.tf === '15m' ? 1 : 2
          ctx.beginPath(); ctx.moveTo(X(idxOfT(lv.active.t1)), Y(lv.active.px1)); ctx.lineTo(right, Y(lv.active.px2)); ctx.stroke()
        }
        if (Number.isFinite(lv.px)) {
          ctx.font = FONT
          label(ctx, X(kLineDataList.length - 1), Y(lv.px), `${h.tf}${isRes ? ' R ' : ' S '}${formatPrice(lv.px)}`, col, '#fff', 'left')
        }
      }
    }
    // fine ▼▲ (size = 9 + 5★)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    for (const f of rp.fine) {
      ctx.font = `${f.size}px system-ui, sans-serif`
      ctx.fillStyle = f.isTop ? '#e5534b' : '#3fb950'
      ctx.fillText(f.text, X(f.idx), Y(f.y) + (f.isTop ? -f.size / 2 : f.size / 2))
      if (f.tag) { ctx.font = FONT; ctx.fillText(f.tag, X(f.idx), Y(f.y) + (f.isTop ? -f.size - 8 : f.size + 8)) }
    }
    ctx.font = FONT
    for (const b of rp.big) label(ctx, X(b.idx), Y(b.price), b.text, b.isTop ? '#800000' : '#0b6e4f', '#fff', b.isTop ? 'down' : 'up')
    for (const c of rp.cBars) label(ctx, X(c.idx), Y(c.y), c.text, 'rgba(128,0,128,0.9)', '#fff', c.up ? 'up' : 'down')
    if (rp.swingTag) label(ctx, X(kLineDataList.length - 1), Y(rp.swingTag.px), rp.swingTag.text, rp.swingTag.down ? '#e24b4a' : '#1aa38a', '#fff', 'left')
    const cd = rp.candidate
    if (cd) label(ctx, X(cd.idx), Y(cd.price), cd.text, 'rgba(255,165,0,0.85)', '#000', cd.isTop ? 'down' : 'up')
    // top-right status table (Pine `dash`)
    if (cd) {
      const tf = (on: boolean, v: number) => (!on ? '关' : Number.isFinite(v) ? formatPrice(v) : '—')
      const need = cd.need
      const rows: [string, string, string?][] = [
        ['RevPoint', ''],
        [cd.isTop ? '候选顶' : '候选底', formatPrice(cd.price)],
        ['★ / 还差', `${starGlyphs(cd.stars)}  ${need > 0 ? `${Number(need.toFixed(2))}%` : '边缘'}`],
        ['OI1h', Number.isFinite(rp.oiChg1h) ? `${rp.oiChg1h > 0 ? '+' : ''}${Number(rp.oiChg1h.toFixed(2))}%` : '—'],
        ['RSI / 1H', `${Number.isFinite(rp.rsi14) ? Math.round(rp.rsi14) : '—'}${(cd.isTop ? rp.trendUp : !rp.trendUp) ? ' 逆1H' : ' 顺1H'}`],
        ['周期', '阻力 R', '支撑 S'],
        ...rp.htf.map(h => [h.tf, tf(h.on, h.r.px), tf(h.on, h.s.px)] as [string, string, string]),
      ]
      const cw = [64, 88, 88], rh = 16, x0 = right - cw.reduce((a, b) => a + b) - 70, y0 = 8
      ctx.fillStyle = 'rgba(20,20,20,0.75)'
      ctx.fillRect(x0, y0, cw[0]! + cw[1]! + cw[2]!, rows.length * rh + 4)
      ctx.textBaseline = 'top'
      rows.forEach((r, i) => {
        ctx.textAlign = 'left'; ctx.fillStyle = i === 1 ? (cd.isTop ? '#ffa500' : '#7ee787') : '#c0c0c0'
        ctx.fillText(r[0], x0 + 4, y0 + 3 + i * rh)
        ctx.textAlign = 'right'
        ctx.fillStyle = i >= 6 ? '#e24b4a' : '#fff'; if (r[1]) ctx.fillText(r[1], x0 + cw[0]! + cw[1]! - 4, y0 + 3 + i * rh)
        ctx.fillStyle = i >= 6 ? '#1aa38a' : '#fff'; if (r[2]) ctx.fillText(r[2], x0 + cw[0]! + cw[1]! + cw[2]! - 4, y0 + 3 + i * rh)
      })
    }
    ctx.restore()
    return false
  },
}
