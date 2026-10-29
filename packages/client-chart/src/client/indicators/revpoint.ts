/**
 * 反转点标注 RevPoint v6.5 overlay. All logic lives in
 * tool-market/src/revpoint.ts (shared with market_snapshot); this file only draws.
 * calcParams:
 *   [0..8]  : 细档%, 粗档%, pivot腿, 15m, 30m, 1H, 2H, 4H, 最少★ (legacy 9 slots)
 *   [9..11] : showBig, showSwing, showC (确认阈值)
 *   [12..15]: volLen, volThr, lookbackHours, oiExch (量能·OI)
 *   [16..17]: needVol, confirmedOnly (过滤·显示)
 *   [18..24]: showHtf, showHtfSlope, showHtfPlots, showHtfHoriz, showHtfTable, showHtfTags, showHtfDebug (多周期趋势线)
 *   [25..27]: alertFine, alertBig, alertC (alertcondition)
 * extendData: provider derivative history (base-coin OI) for the OI1h star.
 */
import { revPoint, REVPOINT_DEFAULTS, REVPOINT_HTF, starGlyphs, linePriceAt } from '../../../../tool-market/src/revpoint.js'
import type { RevPointOpts, RevPointResult, RpLine, RpTf } from '../../../../tool-market/src/revpoint.js'
import { formatPrice } from '../precision.js'
import { statusTableRect, clampLabelBox, layoutEdgeTags, clipExtendX, tableMode } from './revpoint-layout.js'
import { resolveDrawContext, type ChartDrawApi } from './draw-context.js'
export { TABLE_W as REVPOINT_TABLE_W }

type K = { open: number; high: number; low: number; close: number; volume?: number; timestamp?: number; time?: string }
type Row = { rp?: RevPointResult }

export const REVPOINT_OI_EXCHANGES = ['BINANCE', 'OKX', 'BYBIT'] as const

export const REVPOINT_ALERTS = [
  { key: 'fineConfirmed', title: '细档反转确认', cn: '细档反转确认', msg: 'RevPoint: 细档反转点已确认' },
  { key: 'bigConfirmed', title: '大周期反转确认', cn: '大周期反转确认', msg: 'RevPoint: 大周期反转点已确认' },
  { key: 'cFired', title: 'C类枯竭爆量', cn: 'C类枯竭爆量', msg: 'RevPoint: C类缩量后巨量反转K' },
] as const

export const REVPOINT_PARAM_DEFAULTS = [
  0.7, 2.0, 3, 0, 0, 1, 0, 1, 0,
  1, 1, 1,
  20, 2.0, 24, 0,
  0, 1,
  1, 0, 0, 1, 1, 1, 0,
  0, 0, 0,
]

export function migrateRevPointParams(raw: readonly unknown[]): number[] {
  return REVPOINT_PARAM_DEFAULTS.map((d, i) => {
    const v = raw[i]
    return typeof v === 'number' && Number.isFinite(v) ? v : d
  })
}

const FONT = '11px system-ui, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif'
const TABLE_COLS = [56, 80, 80] as const
const TABLE_W = TABLE_COLS[0] + TABLE_COLS[1] + TABLE_COLS[2]
const ROW_H = 16

export function paramsToRevPointOpts(p: readonly unknown[]): Partial<RevPointOpts> {
  const q = migrateRevPointParams(p)
  const htf = Object.fromEntries(REVPOINT_HTF.map((d, i) => [d.key, q[3 + i] === 1])) as Record<RpTf, boolean>
  const exIdx = Math.max(0, Math.min(2, Math.round(q[15]!)))
  return {
    thrPct: q[0]!,
    thrBigPct: q[1]!,
    pivotLeg: q[2]!,
    htf,
    minStars: q[8]!,
    showBig: q[9] === 1,
    showSwing: q[10] === 1,
    showC: q[11] === 1,
    volLen: q[12]!,
    volThr: q[13]!,
    lookbackHours: q[14]!,
    oiExch: REVPOINT_OI_EXCHANGES[exIdx] ?? 'BINANCE',
    needVol: q[16] === 1,
    confirmedOnly: q[17] === 1,
    showHtf: q[18] === 1,
    showHtfSlope: q[19] === 1,
    showHtfPlots: q[20] === 1,
    showHtfHoriz: q[21] === 1,
    showHtfTable: q[22] === 1,
    showHtfTags: q[23] === 1,
    showHtfDebug: q[24] === 1,
    fmt: formatPrice,
  }
}

export function revPointRows(list: readonly { open: number; high: number; low: number; close: number; volume?: number; timestamp: number }[], p: readonly number[], ext?: unknown): Row[] {
  const hist = Array.isArray(ext) ? ext as { time: string; openInterest: number | null }[] : []
  const oi = hist.flatMap(h => (typeof h.openInterest === 'number' ? [{ t: Date.parse(h.time), oi: h.openInterest }] : []))
  const rp = revPoint(
    list.map(k => ({ t: k.timestamp, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume ?? 0 })),
    oi,
    paramsToRevPointOpts(p),
  )
  const rows: Row[] = list.map(() => ({}))
  if (rows.length) rows[0] = { rp }
  return rows
}

export function revPointAlertEvents(
  candles: readonly K[],
  params?: readonly unknown[],
  ext?: unknown,
): { id: string; text: string }[] {
  if (candles.length < 2) return []
  const q = migrateRevPointParams(params ?? [])
  const wantFine = q[25] === 1
  const wantBig = q[26] === 1
  const wantC = q[27] === 1
  if (!wantFine && !wantBig && !wantC) return []
  const norm = candles.map((c, idx) => ({
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume ?? 0,
    timestamp: typeof c.timestamp === 'number' ? c.timestamp : (c.time ? Date.parse(c.time) : idx * 60_000),
  }))
  const rows = revPointRows(norm, q, ext)
  const rp = rows[0]?.rp
  if (!rp || rp.processed === 0) return []
  const closedIdx = Math.min(norm.length - 2, rp.processed - 1)
  if (closedIdx < 0) return []
  const closedBar = norm[closedIdx]!
  const out: { id: string; text: string }[] = []
  if (wantFine && rp.barEvents.fineConfirmed[closedIdx]) {
    out.push({ id: `${closedBar.timestamp}|rp.fineConfirmed`, text: `${REVPOINT_ALERTS[0].title} — ${REVPOINT_ALERTS[0].msg}` })
  }
  if (wantBig && rp.barEvents.bigConfirmed[closedIdx]) {
    out.push({ id: `${closedBar.timestamp}|rp.bigConfirmed`, text: `${REVPOINT_ALERTS[1].title} — ${REVPOINT_ALERTS[1].msg}` })
  }
  if (wantC && rp.barEvents.cFired[closedIdx]) {
    out.push({ id: `${closedBar.timestamp}|rp.cFired`, text: `${REVPOINT_ALERTS[2].title} — ${REVPOINT_ALERTS[2].msg}` })
  }
  return out
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
  calc: (list: { open: number; high: number; low: number; close: number; volume?: number; timestamp: number }[], ind: { calcParams: number[]; extendData?: unknown }) =>
    revPointRows(list, ind.calcParams, ind.extendData),
  createTooltipDataSource: ({ indicator, crosshair }: { indicator: { result: Row[] }; crosshair: { dataIndex?: number } }) => {
    const rp = indicator.result?.[0]?.rp
    const i = crosshair.dataIndex
    const hits = rp && i !== undefined ? [
      ...rp.fine.filter(f => f.idx === i).map(f => ({ title: f.isTop ? '顶 ' : '底 ', value: { text: f.tip, color: f.isTop ? '#f47067' : '#3ddc97' } })),
      ...rp.big.filter(b => b.idx === i).map(b => ({ title: '', value: { text: b.text.replace('\n', ' '), color: '#d29922' } })),
      ...rp.cBars.filter(b => b.idx === i).map(b => ({ title: '', value: { text: b.text, color: '#a371f7' } })),
    ] : []
    return { calcParamsText: '', legends: hits, features: [] }
  },
  draw: ({ ctx, chart, indicator, xAxis, yAxis, bounding }: {
    ctx: CanvasRenderingContext2D
    chart: ChartDrawApi
    indicator: { result: Row[] }
    xAxis: { convertToPixel: (v: number) => number }
    yAxis: { convertToPixel: (v: number) => number }
    bounding: { width: number; height: number }
  }) => {
    const { kLineDataList: rawList } = resolveDrawContext(chart)
    const kLineDataList = rawList as unknown as { open: number; high: number; low: number; close: number; volume?: number; timestamp: number }[]
    const rp = indicator.result?.[0]?.rp
    if (!rp) return false
    const op = rp.opts ?? REVPOINT_DEFAULTS
    const X = (i: number) => xAxis.convertToPixel(i)
    const Y = (v: number) => yAxis.convertToPixel(v)
    const idxOfT = (t: number) => { let k = 0; for (let j = 0; j < kLineDataList.length; j++) if (kLineDataList[j]!.timestamp <= t) k = j; return k }
    const paneW = bounding.width
    const paneH = bounding.height
    const cd = rp.candidate
    const fullH = (6 + rp.htf.length) * ROW_H + 4
    const showTable = op.showHtf && op.showHtfTable
    const mode = cd && showTable ? tableMode(paneH, fullH) : 'hidden'
    const table = mode === 'full' ? statusTableRect(paneW, TABLE_W, fullH)
      : mode === 'compact' ? statusTableRect(paneW, TABLE_W, 2 * ROW_H + 4) : null
    const shortPane = mode !== 'full'

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

    // HTF stepline plots (when showHtf && showHtfPlots)
    if (op.showHtf && op.showHtfPlots && rp.htfStepPlots) {
      for (const h of rp.htf) {
        if (!h.on) continue
        const sp = rp.htfStepPlots[h.tf]
        if (!sp) continue
        const w = h.tf === '4H' ? 2 : 1
        for (const [arr, col] of [[sp.r, h.color.r], [sp.s, h.color.s]] as const) {
          if (!arr || arr.length === 0) continue
          ctx.strokeStyle = col
          ctx.lineWidth = w
          ctx.beginPath()
          let penDown = false
          let prevY = 0
          for (let i = 0; i < arr.length; i++) {
            const v = arr[i] ?? null
            if (v === null || !Number.isFinite(v)) {
              penDown = false
              continue
            }
            const x = X(i), y = Y(v)
            if (!penDown) {
              ctx.moveTo(x, y)
              penDown = true
            } else {
              ctx.lineTo(x, prevY)
              ctx.lineTo(x, y)
            }
            prevY = y
          }
          ctx.stroke()
        }
      }
    }

    // HTF level lines (stop at pane edge / left of price axis)
    const lineRight = paneW - 1
    if (op.showHtf) {
      for (const h of rp.htf) {
        if (!h.on) continue
        for (const [lv, isRes] of [[h.r, true], [h.s, false]] as const) {
          const col = isRes ? h.color.r : h.color.s
          if (lv.active) {
            ctx.strokeStyle = col
            ctx.lineWidth = h.tf === '4H' ? 3 : h.tf === '15m' ? 1 : 2
            ctx.beginPath()
            ctx.moveTo(X(idxOfT(lv.active.t1)), Y(lv.active.px1))
            const ly = Y(lv.active.px2)
            const underTable = table !== null && ly >= table.y && ly <= table.y + table.h
            ctx.lineTo(underTable ? table!.x : lineRight, ly)
            ctx.stroke()
          }
        }
      }
    }

    // Right-edge HTF R/S tags — laid out to avoid the status table and each other
    const edgeIns: { y: number; w: number; h: number; text: string; color: string; priority: number }[] = []
    if (op.showHtf && op.showHtfTags) {
      for (const h of rp.htf) {
        if (!h.on) continue
        for (const [lv, isRes] of [[h.r, true], [h.s, false]] as const) {
          if (!Number.isFinite(lv.px)) continue
          const text = `${h.tf}${isRes ? ' R ' : ' S '}${formatPrice(lv.px)}`
          const w = ctx.measureText(text).width + 10
          const pri = ({ '4H': 5, '2H': 4, '1H': 3, '30m': 2, '15m': 1 } as const)[h.tf]
          if (shortPane && pri < 3) continue
          edgeIns.push({ y: Y(lv.px), w, h: 16, text, color: isRes ? h.color.r : h.color.s, priority: pri })
        }
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
        priority: 0,
      })
    }
    const edgePos = layoutEdgeTags(edgeIns, paneW, paneH, table)
    edgeIns.forEach((t, i) => {
      const p = edgePos[i]
      if (!p) return  // no room: lower-priority tag dropped
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
      // drawn before the opaque table, so the table always wins on overlap
      drawLabel(ctx, X(cd.idx), Y(cd.price), cd.text, 'rgba(255,165,0,0.85)', '#000', cd.isTop ? 'down' : 'up', paneW, paneH)
    }
    if (op.showHtf && op.showHtfDebug && rp.htfDebugText && kLineDataList.length > 0) {
      const li = kLineDataList.length - 1
      drawLabel(ctx, X(li), Y(kLineDataList[li]!.high), rp.htfDebugText, 'rgba(30,30,30,0.92)', '#ff0', 'down', paneW, paneH)
    }

    // Status table — pinned top-right, semi-transparent, clear of the price axis
    if (cd && table && mode === 'compact') {
      ctx.fillStyle = 'rgba(20,20,20,0.96)'
      ctx.fillRect(table.x, table.y, TABLE_W, table.h)
      ctx.textBaseline = 'top'; ctx.textAlign = 'left'
      ctx.fillStyle = cd.isTop ? '#ffa500' : '#7ee787'
      ctx.fillText(`RevPoint ${cd.isTop ? '候选顶' : '候选底'} ${formatPrice(cd.price)} ${starGlyphs(cd.stars)}`, table.x + 4, table.y + 3)
      ctx.fillStyle = '#fff'
      const oi = Number.isFinite(rp.oiChg1h) ? ` OI1h ${rp.oiChg1h > 0 ? '+' : ''}${Number(rp.oiChg1h.toFixed(2))}%` : ''
      ctx.fillText(`${cd.need > 0 ? `还差 ${Number(cd.need.toFixed(2))}%` : '确认边缘'}${oi}`, table.x + 4, table.y + 3 + ROW_H)
    }
    if (cd && table && mode === 'full') {
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
      ctx.fillStyle = 'rgba(20,20,20,0.96)'  // near-opaque: HTF lines must not show through
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
