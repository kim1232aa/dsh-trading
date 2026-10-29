/**
 * RSI grid observations in three parts: RSI_GRID (RSI 0–100 and both sides' thresholds),
 * RSI_GRID_CUM (long strength above zero, short strength below zero) and RSI_GRID_MARKS
 * (next-open entry/exit observations on the candle pane).
 * The calculation engine is shared with market_snapshot; chart parameters may differ.
 */
import { rsiGrid, rsiGridShortParams, RSI_GRID_DEFAULTS } from '../../../../tool-market/src/rsi-grid.js'
import type { RsiGridBar } from '../../../../tool-market/src/rsi-grid.js'
import { formatPrice } from '../precision.js'
import { statusTableRect } from './revpoint-layout.js'
import { resolveDrawContext, type ChartDrawApi } from './draw-context.js'

type K = { open: number; high: number; low: number; close: number; timestamp?: number }
type PositionRow = RsiGridBar & { inPos: boolean; posEntry?: number }
type Row = PositionRow & { short: PositionRow; shortCum: number; longThreshold: number; shortThreshold: number }

const RSI_C = '#539bf5'
const CUM_C = '#ffa726'
const SHORT_C = '#f47067'
const LOW_C = '#f47067'
const HIGH_C = '#3ddc97'
export const RSI_AXIS_MIN = -8
export const RSI_AXIS_MAX = 108
/** Keep a centered label of width w inside [0, paneW]. */
export function clampLabelX(x: number, w: number, paneW: number): number {
  return Math.min(Math.max(x, w / 2 + 2), Math.max(w / 2 + 2, paneW - w / 2 - 2))
}
const FONT = '11px system-ui, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif'

function positionRows(rows: readonly RsiGridBar[]): PositionRow[] {
  let pos: number | undefined
  return rows.map(b => {
    if (b.exit !== undefined) pos = undefined
    if (b.entry !== undefined) pos = b.entry
    return { ...b, inPos: pos !== undefined, ...(pos !== undefined ? { posEntry: pos } : {}) }
  })
}

export function rsiGridRows(list: readonly K[], p: readonly number[]): Row[] {
  const params = p.length === 4 ? p : RSI_GRID_DEFAULTS
  const long = positionRows(rsiGrid(list, params[0], params[1], params[2], params[3], 'long', { closedOnly: true }).bars)
  const short = positionRows(rsiGrid(list, ...rsiGridShortParams(params), 'short', { closedOnly: true }).bars)
  const threshold = params[3] ?? 10
  return long.map((b, i) => ({ ...b, short: short[i]!, shortCum: short[i]!.cum === 0 ? 0 : -short[i]!.cum,
    longThreshold: threshold, shortThreshold: -threshold }))
}

export const rsiGridIndicator = {
  name: 'RSI_GRID',
  shortName: 'RSI网格多空',
  precision: 2,
  // Pine plots RSI against 0–100; cum lives in its own pane (RSI_GRID_CUM) so it can't squash RSI.
  // Padded past 0–100 so 0 isn't pinned to the pane boundary and the 30/60 hlines stay labelled.
  minValue: RSI_AXIS_MIN,
  maxValue: RSI_AXIS_MAX,
  calcParams: [...RSI_GRID_DEFAULTS],
  figures: [
    { key: 'rsi', title: 'RSI: ', type: 'line', styles: () => ({ color: RSI_C }) },
  ],
  calc: (list: K[], ind: { calcParams: number[] }) => rsiGridRows(list, ind.calcParams),
  createTooltipDataSource: ({ chart, indicator, crosshair }: {
    chart: ChartDrawApi
    indicator: { calcParams: number[]; result: Row[] }
    crosshair: { dataIndex?: number }
  }) => {
    const kLineDataList = chart.getDataList() as unknown as K[]
    const res = indicator.result ?? []
    const i = Math.min(crosshair.dataIndex ?? res.length - 1, res.length - 1)
    const r = res[i]
    const [, low, high, th] = indicator.calcParams
    const [, shortLow, shortHigh] = rsiGridShortParams(indicator.calcParams)
    const legends: { title: string; value: { text: string; color: string } }[] = r === undefined ? [] : [
      { title: 'RSI: ', value: { text: r.rsi === null ? '–' : r.rsi.toFixed(2), color: RSI_C } },
      { title: '多累计: ', value: { text: r.rsi === null ? '–' : `${r.cum.toFixed(2)}/${th}`, color: CUM_C } },
      { title: '空累计: ', value: { text: r.rsi === null ? '–' : `${r.shortCum.toFixed(2)}/-${th}`, color: SHORT_C } },
    ]
    if (r) for (const [short, row] of [[false, r], [true, r.short]] as const) {
      if (row.inPos && row.posEntry !== undefined) {
        const c = kLineDataList[i]?.close ?? row.posEntry
        const pnl = 100 * (short ? row.posEntry - c : c - row.posEntry) / row.posEntry
        legends.push({ title: short ? '持空 ' : '持多 ', value: { text: `@${formatPrice(row.posEntry)} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`, color: pnl >= 0 ? HIGH_C : LOW_C } })
      }
      if (row.signal) legends.push({ title: '', value: { text: row.signal === 'entry' ? (short ? '触发进空' : '触发进多') : (short ? '触发平空' : '触发平多'), color: short ? SHORT_C : HIGH_C } })
    }
    if (r?.provisional) legends.push({ title: '', value: { text: '未收盘·不出新信号', color: '#768390' } })
    return { name: 'RSI网格', calcParamsText: `(${indicator.calcParams[0]}｜多<${low}平≥${high} 空>${shortHigh}平≤${shortLow})`, legends, features: [] }
  },
  draw: ({ ctx, indicator, xAxis, yAxis, bounding }: {
    ctx: CanvasRenderingContext2D
    indicator: { calcParams: number[]; result: Row[] }
    xAxis: { convertToPixel: (v: number) => number }
    yAxis: { convertToPixel: (v: number) => number }
    bounding: { width: number }
  }) => {
    const res = indicator.result ?? []
    const [, low, high] = indicator.calcParams as [number, number, number, number]
    const [, shortLow, shortHigh] = rsiGridShortParams(indicator.calcParams)
    ctx.save()
    for (const [v, c, t, align] of [
      [low, HIGH_C, `多入${low}`, 'right'], [high, HIGH_C, `多平${high}`, 'left'],
      [shortLow, SHORT_C, `空平${shortLow}`, 'left'], [shortHigh, SHORT_C, `空入${shortHigh}`, 'right'],
    ] as [number, string, string, CanvasTextAlign][]) {
      const y = yAxis.convertToPixel(v)
      ctx.strokeStyle = c
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(bounding.width, y)
      ctx.stroke()
      ctx.fillStyle = c
      ctx.font = FONT
      ctx.textAlign = align
      ctx.fillText(t, align === 'left' ? 4 : bounding.width - 4, y - 3)
    }
    ctx.setLineDash([])
    ctx.restore()
    return false
  },
}

type DrawArgs = {
  ctx: CanvasRenderingContext2D
  chart?: ChartDrawApi
  indicator: { calcParams: number[]; result: Row[] }
  xAxis: { convertToPixel: (v: number) => number }
  yAxis: { convertToPixel: (v: number) => number }
  bounding: { width: number }
}

/** Positive long strength and negative short strength; each retains its own unsigned strategy accumulator. */
export const rsiGridCumIndicator = {
  name: 'RSI_GRID_CUM',
  shortName: '累计差值·多空',
  precision: 2,
  calcParams: [...RSI_GRID_DEFAULTS],
  figures: [
    { key: 'cum', title: '多累计: ', type: 'line', styles: () => ({ color: CUM_C }) },
    { key: 'shortCum', title: '空累计: ', type: 'line', styles: () => ({ color: SHORT_C }) },
    { key: 'longThreshold', title: '多阈值: ', type: 'line', styles: () => ({ color: CUM_C, style: 'dashed', dashedValue: [4, 3] }) },
    { key: 'shortThreshold', title: '空阈值: ', type: 'line', styles: () => ({ color: SHORT_C, style: 'dashed', dashedValue: [4, 3] }) },
  ],
  calc: (list: K[], ind: { calcParams: number[] }) => rsiGridRows(list, ind.calcParams),
  createTooltipDataSource: ({ indicator, crosshair }: { indicator: { calcParams: number[]; result: Row[] }; crosshair: { dataIndex?: number } }) => {
    const rows = indicator.result ?? []
    const row = rows[Math.min(crosshair.dataIndex ?? rows.length - 1, rows.length - 1)]
    const value = (n: number) => row?.rsi === null ? '–' : n.toFixed(2)
    return { calcParamsText: `(多+ 空−｜±${indicator.calcParams[3] ?? 10})`, features: [], legends: row ? [
      { title: '多累计: ', value: { text: value(row.cum), color: CUM_C } },
      { title: '空累计: ', value: { text: value(row.shortCum), color: SHORT_C } },
    ] : [] }
  },
  draw: ({ ctx, indicator, yAxis, bounding }: DrawArgs) => {
    const th = indicator.calcParams[3] ?? 10
    ctx.save()
    ctx.strokeStyle = '#768390'
    ctx.globalAlpha = 0.5
    const zero = yAxis.convertToPixel(0)
    ctx.beginPath(); ctx.moveTo(0, zero); ctx.lineTo(bounding.width, zero); ctx.stroke()
    ctx.globalAlpha = 1
    ctx.font = FONT; ctx.textAlign = 'right'
    for (const [n, color, label] of [[th, CUM_C, `多阈值${th}`], [-th, SHORT_C, `空阈值-${th}`]] as const) {
      ctx.fillStyle = color
      ctx.fillText(label, bounding.width - 4, yAxis.convertToPixel(n) - 3)
    }
    ctx.restore()
    return false
  },
}

/**
 * strategy.entry / strategy.close markers on the CANDLE pane, at the fill bar
 * (next open after the signal close), like TradingView draws strategy orders.
 */
export const rsiGridMarksIndicator = {
  name: 'RSI_GRID_MARKS',
  shortName: 'RSI网格信号',
  series: 'price',
  calcParams: [...RSI_GRID_DEFAULTS],
  figures: [],
  calc: (list: K[], ind: { calcParams: number[] }) => rsiGridRows(list, ind.calcParams),
  createTooltipDataSource: () => ({ name: '', calcParamsText: '', legends: [], features: [] }),
  draw: ({ ctx, chart, indicator, xAxis, yAxis, bounding }: DrawArgs) => {
    if (!chart) return false
    const { visibleRange, kLineDataList: rawList } = resolveDrawContext(chart)
    const kLineDataList = rawList as unknown as K[]
    const res = indicator.result ?? []
    ctx.save()
    ctx.font = FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let i = Math.max(0, visibleRange.from); i < Math.min(res.length, visibleRange.to); i++) {
      const r = res[i]!
      const k = kLineDataList[i]
      if (!k) continue
      const x = xAxis.convertToPixel(i)
      for (const [short, row] of [[false, r], [true, r.short]] as const) {
        for (const isEntry of [true, false]) {
          const px = isEntry ? row.entry : row.exit
          if (px === undefined) continue
          const below = short !== isEntry
          const yBar = yAxis.convertToPixel(below ? k.low : k.high)
          const y = yBar + (below ? 1 : -1) * (short ? 34 : 16)
          const col = below ? HIGH_C : LOW_C
          ctx.fillStyle = col
          ctx.beginPath()
          if (below) { ctx.moveTo(x, yBar + 4); ctx.lineTo(x - 5, yBar + 9); ctx.lineTo(x + 5, yBar + 9) }
          else { ctx.moveTo(x, yBar - 4); ctx.lineTo(x - 5, yBar - 9); ctx.lineTo(x + 5, yBar - 9) }
          ctx.fill()
          const txt = `${isEntry ? (short ? 'RSI空头' : 'RSI多头') : (short ? '平空' : '平多')} ${formatPrice(px)}`
          const w = ctx.measureText(txt).width + 8
          const lx = clampLabelX(x, w, bounding.width)
          ctx.beginPath(); ctx.rect(lx - w / 2, y - 8, w, 16); ctx.fill()
          ctx.fillStyle = '#fff'
          ctx.fillText(txt, lx, y)
        }
      }
    }
    // Open position whose entry bar may be scrolled out of view: Pine keeps holding
    // (no exit while openprofit < 0, pyramiding = 1 ignores new entries), so show
    // the cost line — otherwise a 累计差值 spike with no marker looks like a bug.
    const lastIndex = Math.min(res.length - 1, Math.ceil(visibleRange.to) - 1)
    const last = res[lastIndex]
    if (last) for (const [short, row] of [[false, last], [true, last.short]] as const) {
      if (!row.inPos || row.posEntry === undefined) continue
      const y = yAxis.convertToPixel(row.posEntry)
      const c = kLineDataList[lastIndex]?.close ?? row.posEntry
      const pnl = 100 * (short ? row.posEntry - c : c - row.posEntry) / row.posEntry
      const color = short ? SHORT_C : HIGH_C
      ctx.strokeStyle = color
      ctx.setLineDash([6, 4])
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(bounding.width, y); ctx.stroke()
      ctx.setLineDash([])
      let txt = `RSI网格${short ? '持空' : '持多'} @${formatPrice(row.posEntry)} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%（浮亏不平、不加仓）`
      const maxWidth = Math.max(0, bounding.width - 8)
      if (ctx.measureText(txt).width > maxWidth) {
        while (txt.length && ctx.measureText(`${txt}…`).width > maxWidth) txt = txt.slice(0, -1)
        if (!txt) continue
        txt += '…'
      }
      const x = costLabelX(ctx.measureText(txt).width, y, bounding.width)
      ctx.textAlign = 'left'
      ctx.fillStyle = color
      ctx.fillText(txt, x, y + (short ? 18 : -8))
    }
    ctx.restore()
    return false
  },
}

/**
 * Cost-line label anchored right, just before the price axis — clear of the
 * top-left OHLC box. If the line runs through the RevPoint table band, sit left of the table.
 */
export function costLabelX(textW: number, y: number, paneW: number, tableW = 216, tableH = 180): number {
  const t = statusTableRect(paneW, tableW, tableH)
  const right = y >= t.y - 10 && y <= t.y + t.h + 10 ? t.x - 8 : paneW - 8
  return Math.max(4, right - textW)
}
