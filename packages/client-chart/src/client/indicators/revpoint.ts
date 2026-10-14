/**
 * 反转点标注 RevPoint v6.5 overlay. All logic lives in
 * tool-market/src/revpoint.ts (shared with market_snapshot); this file only draws.
 * calcParams: [细档%, 粗档%, pivot腿, 15m, 30m, 1H, 2H, 4H, 最少★]
 * extendData: provider derivative history (base-coin OI) for the OI1h star.
 */
import { revPoint, REVPOINT_HTF, starGlyphs, linePriceAt } from '../../../../tool-market/src/revpoint.js'
import type { RevPointResult, RpLine, RpTf } from '../../../../tool-market/src/revpoint.js'
import { formatPrice } from '../precision.js'
import { statusTableRect, clampLabelBox, layoutEdgeTags, clipExtendX, PRICE_AXIS_GAP } from './revpoint-layout.js'

type K = { open: number; high: number; low: number; close: number; volume?: number; timestamp: number }
type Row = { rp?: RevPointResult }

export const REVPOINT_PARAM_DEFAULTS = [0.7, 2.0, 3, 0, 0, 1, 0, 1, 0]
const FONT = '11px system-ui, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif'
const TABLE_COLS = [56, 80, 80] as const
const TABLE_W = TABLE_COLS[0] + TABLE_COLS[1] + TABLE_COLS[2]
const ROW_H = 16

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

function measureLabel(ctx: CanvasRenderingContext2D, text: string): { w: number; h: number; lines: string[] } {
  const lines = text.split('\n')
  return { w: Math.max(...lines.map(l => ctx.measureText(l).width)) + 10, h: lines.length * 14 + 4, lines }
}

/** Draw a label box; clamps into the pane and skips when the anchor is mostly off-screen. */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  bg: string,
  fg: string,
  anchor: 'up' | 'down' | 'left' | 'center',
  paneW: number,
  paneH: number,
): void {
  const { w, h, lines } = measureLabel(ctx, text)
  let bx = anchor === 'left' ? x + 4 : anchor === 'center' ? x - w / 2 : x - w / 2
  let by = anchor === 'down' ? y - h - 6 : anchor === 'up' ? y + 6 : y - h / 2
  const clamped = clampLabelBox(bx, by, w, h, paneW, paneH)
  if (clamped === null) return
  bx = clamped.x
  by = clamped.y
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
    const paneW = bounding.width
    const paneH = bounding.height
    const cd = rp.candidate
    const tableRows = cd ? 6 + rp.htf.length : 0
    const table = cd ? statusTableRect(paneW, TABLE_W, tableRows * ROW_H + 4) : null

    ctx.save()
    // Clip all drawing to the pane so extend.right rays stop at the right edge.
    ctx.beginPath()
    ctx.rect(0, 0, paneW, paneH)
    ctx.clip()
    ctx.font = FONT

    // swing trendlines — Pine extend.right, clipped to pane edge
    for (const l of [rp.lines.fineUp, rp.lines.fineDn, rp.lines.upLn, rp.lines.dnLn]) {
      if (!l) continue
      ctx.strokeStyle = l.color
      ctx.lineWidth = l.width
      ctx.setLineDash(DASH[l.style])
      const x1 = X(l.x1)
      const y1 = Y(l.y1)
      let x2: number
      let y2: number
      if (l.extend) {
        const xe = kLineDataList.length + 50
        x2 = clipExtendX(x1, X(xe), paneW)
        y2 = Y(linePriceAt(l, xe))
      } else {
        x2 = X(l.x2)
        y2 = Y(l.y2)
      }
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
    }
    ctx.setLineDash([])

    // HTF level lines (stop at pane edge / left of price axis)
    const lineRight = paneW - 1
    for (const h of rp.htf) {
      if (!h.on) continue
      for (const [lv, isRes] of [[h.r, true], [h.s, false]] as const) {
        const col = isRes ? h.color.r : h.color.s
        if (lv.active) {
          ctx.strokeStyle = col
          ctx.lineWidth = h.tf === '4H' ? 3 : h.tf === '15m' ? 1 : 2
          ctx.beginPath()
          ctx.moveTo(X(idxOfT(lv.active.t1)), Y(lv.active.px1))
          ctx.lineTo(lineRight, Y(lv.active.px2))
          ctx.stroke()
        }
      }
    }

    // Right-edge HTF R/S tags — laid out to avoid the status table and each other
    const edgeIns: { y: number; w: number; h: number; text: string; color: string }[] = []
    for (const h of rp.htf) {
      if (!h.on) continue
      for (const [lv, isRes] of [[h.r, true], [h.s, false]] as const) {
        if (!Number.isFinite(lv.px)) continue
        const text = `${h.tf}${isRes ? ' R ' : ' S '}${formatPrice(lv.px)}`
        const w = ctx.measureText(text).width + 10
        edgeIns.push({ y: Y(lv.px), w, h: 16, text, color: isRes ? h.color.r : h.color.s })
      }
    }
    if (rp.swingTag) {
      const text = rp.swingTag.text
      edgeIns.push({
        y: Y(rp.swingTag.px),
        w: ctx.measureText(text).width + 10,
        h: 16,
        text,
        color: rp.swingTag.down ? '#e24b4a' : '#1aa38a',
      })
    }
    const edgePos = layoutEdgeTags(edgeIns, paneW, paneH, table)
    edgeIns.forEach((t, i) => {
      const p = edgePos[i]!
      ctx.fillStyle = t.color
      ctx.fillRect(p.x, p.y, t.w, t.h)
      ctx.fillStyle = '#fff'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillText(t.text, p.x + 5, p.y + 2)
    })

    // fine ▼▲
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const f of rp.fine) {
      const fx = X(f.idx)
      if (fx < -20 || fx > paneW + 20) continue
      ctx.font = `${f.size}px system-ui, sans-serif`
      ctx.fillStyle = f.isTop ? '#e5534b' : '#3fb950'
      ctx.fillText(f.text, fx, Y(f.y) + (f.isTop ? -f.size / 2 : f.size / 2))
      if (f.tag) {
        ctx.font = FONT
        ctx.fillText(f.tag, fx, Y(f.y) + (f.isTop ? -f.size - 8 : f.size + 8))
      }
    }
    ctx.font = FONT
    for (const b of rp.big) {
      drawLabel(ctx, X(b.idx), Y(b.price), b.text, b.isTop ? '#800000' : '#0b6e4f', '#fff', b.isTop ? 'down' : 'up', paneW, paneH)
    }
    for (const c of rp.cBars) {
      drawLabel(ctx, X(c.idx), Y(c.y), c.text, 'rgba(128,0,128,0.9)', '#fff', c.up ? 'up' : 'down', paneW, paneH)
    }
    if (cd) {
      drawLabel(ctx, X(cd.idx), Y(cd.price), cd.text, 'rgba(255,165,0,0.85)', '#000', cd.isTop ? 'down' : 'up', paneW, paneH)
    }

    // Status table — pinned top-right, semi-transparent, clear of the price axis
    if (cd && table) {
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
      const { x: x0, y: y0 } = table
      ctx.fillStyle = 'rgba(20,20,20,0.82)'
      ctx.fillRect(x0, y0, TABLE_W, table.h)
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 1
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, TABLE_W - 1, table.h - 1)
      ctx.textBaseline = 'top'
      rows.forEach((r, i) => {
        ctx.textAlign = 'left'
        ctx.fillStyle = i === 1 ? (cd.isTop ? '#ffa500' : '#7ee787') : '#c0c0c0'
        ctx.fillText(r[0], x0 + 4, y0 + 3 + i * ROW_H)
        ctx.textAlign = 'right'
        ctx.fillStyle = i >= 6 ? '#e24b4a' : '#fff'
        if (r[1]) ctx.fillText(r[1], x0 + TABLE_COLS[0] + TABLE_COLS[1] - 4, y0 + 3 + i * ROW_H)
        ctx.fillStyle = i >= 6 ? '#1aa38a' : '#fff'
        if (r[2]) ctx.fillText(r[2], x0 + TABLE_W - 4, y0 + 3 + i * ROW_H)
      })
    }

    ctx.restore()
    return false
  },
}
