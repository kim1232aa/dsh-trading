/**
 * The candlestick card claiming the `tool.call.toolview` slot for
 * `market_snapshot`, `get_ohlcv`, and `annotate_chart`. Reads the durable,
 * model-invisible chart payload from `block.meta`; degrades to the raw
 * rendered text when the payload is absent.
 *
 * Extensibility: annotation rendering is an open registry. A renderer is a
 * PURE function from an annotation object to declarative draw primitives
 * (hline / region / polyline) — it never touches the charting library, so
 * third-party renderers survive chart re-inits (tab switch, chip toggle,
 * theme change) and klinecharts upgrades. Core types 'level', 'zone', 'path'
 * go through the same registry; unknown types without a renderer fall back
 * to a textual row in the annotations table.
 */
import { Component, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ErrorInfo, ReactNode } from 'react'
import { ActionType, TooltipShowRule, dispose, init, registerIndicator, registerOverlay } from 'klinecharts'
import type { Chart, OverlayCreateFiguresCallbackParams } from 'klinecharts'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { publishLatestChart } from './latest.js'
import { annotationDigest, contentText, readChartPayload } from './payload.js'
import type { ChartAnnotation, ChartPayload, ChartScenario, ChartTimeframeData } from './payload.js'
import type { PanelDerivativeBar, PanelDerivatives } from './market-client.js'
import { postureColor } from './market-client.js'
import { regimeSnapshot } from '../../../tool-market/src/regime.js'
import { regimeSeries } from '../../../tool-market/src/chart-payload.js'
import { evasiveSuperTrend, evasiveSuperTrendIndicator } from './indicators/evasive-st.js'
import { nadarayaWatsonTrend, nadarayaWatsonIndicator } from './indicators/nadaraya-watson.js'
import { orderBlockBreaker, orderBlockIndicator } from './indicators/order-blocks.js'
import { mtfSRZones, mtfSRIndicator } from './indicators/mtf-sr.js'
import { entrySignalIndicator } from './indicators/entry-signal.js'
import { rsiGridIndicator } from './indicators/rsi-grid.js'

export { evasiveSuperTrend } from './indicators/evasive-st.js'
export { nadarayaWatsonTrend } from './indicators/nadaraya-watson.js'
export { orderBlockBreaker } from './indicators/order-blocks.js'
export { mtfSRZones } from './indicators/mtf-sr.js'

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })
let chartDomSeq = 0

const CHART_HEIGHT = 320
const PANE_HEIGHT = 90

/**
 * klinecharts defaults to 'Helvetica Neue', which Windows lacks — CJK captions
 * then fall back to whatever the canvas picks. Name real UI faces per platform.
 */
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif'

/** Mark captions: legible size, and a backing so they read over candles. */
function labelStyle(color: string): Record<string, unknown> {
  return {
    color, size: 11, weight: 500, family: FONT_FAMILY,
    backgroundColor: 'rgba(22,24,28,0.72)', borderRadius: 2,
    paddingLeft: 3, paddingRight: 3, paddingTop: 1, paddingBottom: 1,
  }
}

type Palette = {
  text: string
  faint: string
  line: string
  up: string
  down: string
  neckline: string
  target: string
  invalidation: string
}

const LIGHT: Palette = {
  text: '#333c45', faint: '#8b949e', line: '#e5e8eb', up: '#26a17b', down: '#e0563f',
  neckline: '#b08800', target: '#3b7dd8', invalidation: '#a475e0',
}
const DARK: Palette = {
  text: '#c9d1d9', faint: '#768390', line: '#30363d', up: '#3ddc97', down: '#f47067',
  neckline: '#d4a72c', target: '#539bf5', invalidation: '#b083f0',
}

/* ------------------------------------------------------------------ */
/* Open annotation-renderer registry (the ecosystem seam)              */
/* ------------------------------------------------------------------ */

export type DrawPrimitive =
  | { kind: 'hline'; price: number; label?: string; color?: string; dashed?: boolean }
  | { kind: 'region'; low: number; high: number; label?: string; color?: string }
  | { kind: 'polyline'; points: { time: string; price: number }[]; label?: string; color?: string; dashed?: boolean }

export type AnnotationRendererContext = {
  /** Bumped only on breaking changes to DrawPrimitive/this context. */
  contractVersion: 1
  timeframe: string
  close: number
  palette: Palette
}

/**
 * PURE translator from one annotation object to draw primitives. Runs on
 * every chart re-init; must not keep state or touch the DOM. Throwing skips
 * this annotation (logged), never the card.
 */
export type AnnotationRenderer = (
  annotation: Record<string, unknown>,
  ctx: AnnotationRendererContext,
) => DrawPrimitive[]

const annotationRenderers = new Map<string, AnnotationRenderer>()

/** Last registration wins (logged); returns an unregister disposer. */
export function registerAnnotationRenderer(type: string, renderer: AnnotationRenderer): () => void {
  if (annotationRenderers.has(type)) {
    console.warn(`[client-chart] annotation renderer for '${type}' replaced`)
  }
  annotationRenderers.set(type, renderer)
  return () => {
    if (annotationRenderers.get(type) === renderer) annotationRenderers.delete(type)
  }
}

function roleColor(role: unknown, p: Palette): string {
  switch (role) {
    case 'support': return p.up
    case 'resistance': return p.down
    case 'neckline': return p.neckline
    case 'target': return p.target
    case 'invalidation': return p.invalidation
    default: return p.faint
  }
}

function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x !== '' ? x : undefined
}

// Core renderers ride the same registry as third-party ones.
registerAnnotationRenderer('level', (a, ctx) => {
  const price = num(a['price'])
  if (price === undefined) return []
  return [{ kind: 'hline', price, dashed: true, color: roleColor(a['role'], ctx.palette), ...str(a['label']) !== undefined ? { label: str(a['label'])! } : {} }]
})
registerAnnotationRenderer('zone', (a, ctx) => {
  const low = num(a['low'])
  const high = num(a['high'])
  if (low === undefined || high === undefined) return []
  return [{ kind: 'region', low, high, color: roleColor(a['role'], ctx.palette), ...str(a['label']) !== undefined ? { label: str(a['label'])! } : {} }]
})
registerAnnotationRenderer('path', (a, ctx) => {
  const raw = a['points']
  if (!Array.isArray(raw)) return []
  const points = raw.flatMap((p) => {
    const time = typeof p === 'object' && p !== null ? str((p as Record<string, unknown>)['time']) : undefined
    const price = typeof p === 'object' && p !== null ? num((p as Record<string, unknown>)['price']) : undefined
    return time !== undefined && price !== undefined ? [{ time, price }] : []
  })
  if (points.length < 2) return []
  return [{ kind: 'polyline', points, dashed: true, color: roleColor(a['role'], ctx.palette), ...str(a['label']) !== undefined ? { label: str(a['label'])! } : {} }]
})

/* ------------------------------------------------------------------ */
/* klinecharts wiring                                                  */
/* ------------------------------------------------------------------ */

/** Trend overlay on every chart. */
const WMA_PERIODS = [60, 100, 200]
const WMA_COLORS = ['#FFA726', '#27C6DA', '#E65000']

/**
 * Linear-weighted MA ending at bar `i`: weights 1..p, newest heaviest.
 * undefined until there are `p` bars. O(p) per bar — 1000 bars × 200 is 0.2M ops, fine.
 */
export function wmaAt(closes: readonly number[], i: number, p: number): number | undefined {
  if (p < 1 || i < p - 1 || i >= closes.length) return undefined
  let sum = 0
  for (let k = 0; k < p; k++) sum += closes[i - k]! * (p - k)
  return sum / (p * (p + 1) / 2)
}

/** up, down — the down red is sampled from the reference shot, the green is TradingView's pair for it. */
const ST_COLORS = ['#089981', '#F23645']

/**
 * TradingView `ta.supertrend(factor, atrPeriod)`: Wilder ATR around hl2, bands
 * only ratchet toward price, direction flips on a close through the active band.
 * Each bar carries `up` OR `dn`, so a flip leaves a gap instead of a vertical join.
 * Empty `{}` until the ATR window is full.
 */
export function supertrend(
  bars: readonly { high: number; low: number; close: number }[],
  period: number,
  factor: number,
): { up?: number; dn?: number }[] {
  const out: { up?: number; dn?: number }[] = []
  let atr: number | undefined
  let trSum = 0
  let lower = 0
  let upper = 0
  let down: boolean | undefined
  for (let i = 0; i < bars.length; i++) {
    const { high, low, close } = bars[i]!
    const prevClose = bars[i - 1]?.close
    const tr = prevClose === undefined
      ? high - low
      : Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
    if (atr !== undefined) atr = (atr * (period - 1) + tr) / period
    else {
      trSum += tr
      if (i === period - 1) atr = trSum / period
    }
    if (atr === undefined) {
      out.push({})
      continue
    }
    const mid = (high + low) / 2
    let lo = mid - factor * atr
    let hi = mid + factor * atr
    if (down !== undefined && prevClose !== undefined) {
      if (!(lo > lower || prevClose < lower)) lo = lower
      if (!(hi < upper || prevClose > upper)) hi = upper
    }
    down = down === undefined ? true : down ? !(close > hi) : close < lo
    lower = lo
    upper = hi
    out.push(down ? { dn: hi } : { up: lo })
  }
  return out
}
/* User-editable indicator params: one store for every chart on the    */
/* page, persisted in localStorage.                                    */
/* ------------------------------------------------------------------ */

type ParamSpec = { label: string; min: number; max: number; step: number }
const period = (label: string): ParamSpec => ({ label, min: 1, max: 500, step: 1 })

export const EDITABLE: {
  name: string
  title: string
  defaults: number[]
  defaultVisible?: boolean
  /** Sub-pane id; omitted = drawn on the price pane. */
  pane?: string
  params: ParamSpec[]
}[] = [
  { name: 'WMA', title: 'WMA', defaults: WMA_PERIODS, params: [period('周期1'), period('周期2'), period('周期3')] },
  { name: 'SUPERTREND', title: '超级趋势', defaults: [60, 4], params: [period('ATR周期'), { label: '倍数', min: 0.1, max: 20, step: 0.1 }] },
  { name: 'EVASIVE_ST', title: '避险超级趋势(LuxAlgo)', defaults: [10, 3.0, 1.0, 0.5], defaultVisible: false, params: [period('ATR周期'), { label: '倍数', min: 0.1, max: 20, step: 0.1 }, { label: '噪音阈值', min: 0.1, max: 10, step: 0.1 }, { label: '避险Alpha', min: 0, max: 5, step: 0.1 }] },
  { name: 'NW_TREND', title: '核回归趋势(QuantAlgo)', defaults: [50, 8, 2.0, 1.8], defaultVisible: false, params: [period('回溯周期'), { label: '带宽', min: 1, max: 50, step: 1 }, { label: '倍数', min: 0.5, max: 10, step: 0.1 }, { label: '通道倍数', min: 0.5, max: 10, step: 0.1 }] },
  { name: 'OB_BB', title: '订单块/破坏块(RWB)', defaults: [], defaultVisible: false, params: [] },
  { name: 'MTF_SR', title: '多周期支撑阻力(Syndicate)', defaults: [5], defaultVisible: false, params: [period('Pivot周期')] },
  { name: 'OI_POSTURE', title: '持仓动向', defaults: [], params: [] },
  { name: 'ENTRY_SIGNAL', title: '多空进场信号(未验证)', defaults: [60, 4], defaultVisible: false, params: [period('ST周期'), { label: 'ST倍数', min: 0.1, max: 20, step: 0.1 }] },
]

export type IndicatorSettings = Record<string, { params: number[]; visible: boolean }>

/** Trust boundary (localStorage is user-editable): anything off-spec falls back to its default, per field. */
export function sanitizeSettings(raw: unknown): IndicatorSettings {
  const src = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  return Object.fromEntries(EDITABLE.map(def => {
    const e = src[def.name]
    const entry = typeof e === 'object' && e !== null ? e as { params?: unknown; visible?: unknown } : {}
    const given: unknown[] = Array.isArray(entry.params) ? entry.params : []
    const params = def.params.map((spec, i) => {
      const v = given[i]
      return typeof v === 'number' && v >= spec.min && v <= spec.max && (spec.step !== 1 || Number.isInteger(v))
        ? v
        : def.defaults[i]!
    })
    const visible = typeof entry.visible === 'boolean' ? entry.visible : (def.defaultVisible ?? true)
    return [def.name, { params, visible }]
  }))
}

const SETTINGS_KEY = 'dsh-trading.chart-indicators.v1'
let settingsCache: IndicatorSettings | undefined
const settingsListeners = new Set<() => void>()

function getSettings(): IndicatorSettings {
  if (settingsCache === undefined) {
    let raw: unknown = null
    try { raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') } catch { /* absent or corrupt: defaults */ }
    settingsCache = sanitizeSettings(raw)
  }
  return settingsCache
}

function setSettings(next: IndicatorSettings): void {
  settingsCache = sanitizeSettings(next)
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsCache)) } catch { /* storage off: this session only */ }
  for (const l of settingsListeners) l()
}

function subscribeSettings(l: () => void): () => void {
  settingsListeners.add(l)
  return () => { settingsListeners.delete(l) }
}

/** Legend cog on the editable indicators; a click opens the param row (ActionType.OnTooltipIconClick). */
const GEAR = {
  id: 'params', position: 'right', icon: '⚙', size: 12, fontFamily: 'Segoe UI Symbol, Apple Symbols, sans-serif',
  color: '#8b949e', activeColor: '#c9d1d9', backgroundColor: 'transparent', activeBackgroundColor: 'rgba(139,148,158,0.2)',
  marginLeft: 4, marginTop: 4, marginRight: 4, marginBottom: 4, paddingLeft: 2, paddingTop: 0, paddingRight: 2, paddingBottom: 0,
}

/** 折叠十字线浮窗里的指标行，只留 时间/开高低收，点一下在“收起/展开”之间切换。 */
const FOLD = {
  id: 'fold', position: 'right', icon: '▤', size: 12, fontFamily: 'Segoe UI Symbol, Apple Symbols, sans-serif',
  color: '#8b949e', activeColor: '#c9d1d9', backgroundColor: 'transparent', activeBackgroundColor: 'rgba(139,148,158,0.2)',
  marginLeft: 4, marginTop: 4, marginRight: 4, marginBottom: 4, paddingLeft: 2, paddingTop: 0, paddingRight: 2, paddingBottom: 0,
}

let registered = false

function ensureRegistered(): void {
  if (registered) return
  registered = true
  // Data rides extendData, not calcParams: klinecharts prints calcParams into
  // the pane's tooltip title, which would render as "[object Object]" spam.
  const passthrough = (_dl: unknown[], ind: { extendData: unknown }): unknown[] =>
    ind.extendData as unknown[]
  const line = (key: string, title: string): { key: string; title: string; type: string } =>
    ({ key, title: `${title}: `, type: 'line' })
  const defs: { name: string; shortName: string; figures: { key: string; title: string; type: string; baseValue?: number }[] }[] = [
    { name: 'TM_RSI', shortName: 'RSI14*', figures: [line('rsi', 'RSI14')] },
    { name: 'TM_STOCH', shortName: 'STOCH*', figures: [line('k', 'K'), line('d', 'D')] },
    { name: 'TM_ADX', shortName: 'ADX*', figures: [line('adx', 'ADX'), line('pdi', '+DI'), line('mdi', '-DI')] },
    { name: 'TM_MACD', shortName: 'MACD*', figures: [{ key: 'hist', title: '柱: ', type: 'bar', baseValue: 0 }, line('macd', 'MACD'), line('signal', '信号')] },
    { name: 'TM_MFI', shortName: 'MFI14*', figures: [line('mfi', 'MFI14')] },
    { name: 'TM_BB', shortName: '布林(20,2)*', figures: [line('upper', '上'), line('middle', '中'), line('lower', '下')] },
  ]
  for (const def of defs) {
    registerIndicator({ ...def, calc: passthrough } as never)
  }

  // klinecharts ships MA/EMA/SMA but no WMA. Empty shortName so the legend reads
  // "WMA(60) x  WMA(100) y  WMA(200) z"; colours sampled from the reference shot.
  const wmaFigures = (params: number[]): { key: string; title: string; type: string }[] =>
    params.map((p, i) => ({ key: `wma${i}`, title: `WMA(${p}) `, type: 'line' }))
  registerIndicator({
    name: 'WMA',
    shortName: '',
    series: 'price',
    precision: 2,
    shouldOhlc: true,
    calcParams: WMA_PERIODS,
    figures: wmaFigures(WMA_PERIODS),
    regenerateFigures: wmaFigures,
    styles: { lines: WMA_COLORS.map(color => ({ color, size: 1, style: 'solid', smooth: false, dashedValue: [2, 2] })) },
    calc: (dataList: { close: number }[], ind: { calcParams: number[] }) => {
      const closes = dataList.map(k => k.close)
      return closes.map((_c, i) =>
        Object.fromEntries(ind.calcParams.flatMap((p, j) => {
          const v = wmaAt(closes, i, p)
          return v === undefined ? [] : [[`wma${j}`, v]]
        })))
    },
    createTooltipDataSource: () => ({ icons: [GEAR] }),
  } as never)

  registerIndicator({
    name: 'SUPERTREND',
    shortName: '超级趋势',
    series: 'price',
    precision: 2,
    calcParams: [60, 4],
    figures: [{ key: 'up', type: 'line' }, { key: 'dn', type: 'line' }],
    styles: { lines: ST_COLORS.map(color => ({ color, size: 1, style: 'solid', smooth: false, dashedValue: [2, 2] })) },
    calc: (dataList: { high: number; low: number; close: number }[], ind: { calcParams: number[] }) =>
      supertrend(dataList, ind.calcParams[0]!, ind.calcParams[1]!),
    // One value coloured by side, params spaced "(60, 4)" like the reference shot.
    createTooltipDataSource: ({ indicator, crosshair }: {
      indicator: { calcParams: number[]; result: { up?: number; dn?: number }[] }
      crosshair: { dataIndex?: number }
    }) => {
      const row = indicator.result[crosshair.dataIndex ?? indicator.result.length - 1]
      const v = row?.up ?? row?.dn
      return {
        calcParamsText: `(${indicator.calcParams.join(', ')})`,
        values: v === undefined ? [] : [{ title: '', value: { text: v, color: ST_COLORS[row?.up !== undefined ? 0 : 1] } }],
        icons: [GEAR],
      }
    },
  } as never)

  registerIndicator({
    name: 'OI_POSTURE',
    shortName: '持仓动向',
    series: 'price',
    figures: [],
    calc: () => [],
    createTooltipDataSource: ({ indicator, crosshair, kLineDataList }: {
      indicator: { extendData?: unknown }
      crosshair: { dataIndex?: number; kLineData?: { timestamp?: number } }
      kLineDataList: { timestamp?: number }[]
    }) => {
      const history = (indicator.extendData ?? []) as PanelDerivativeBar[]
      if (!Array.isArray(history) || history.length === 0) {
        return { name: '', calcParamsText: '', values: [] }
      }
      const dataIndex = crosshair.dataIndex ?? (kLineDataList.length - 1)
      const ts = crosshair.kLineData?.timestamp ?? kLineDataList[dataIndex]?.timestamp
      let target: PanelDerivativeBar | undefined
      if (ts !== undefined) {
        const sec = Math.floor(ts / 1000)
        target = history.find(h => {
          const hSec = Math.floor(Date.parse(h.time) / 1000)
          return Math.abs(hSec - sec) < 300
        })
      }
      const bar = target ?? history[history.length - 1]!
      const pColor = postureColor(bar.posture).color
      const oiText = bar.openInterestValue ? `$${compact.format(bar.openInterestValue)}` : '—'
      const lsrText = bar.longShortRatio ? bar.longShortRatio.toFixed(2) : '—'
      const topPos = bar.topPositionRatio ? bar.topPositionRatio.toFixed(2) : null
      const values = [
        { title: 'OI: ', value: { text: oiText, color: '#27C6DA' } },
        { title: '动向: ', value: { text: bar.posture ?? '—', color: pColor } },
        { title: '散户比: ', value: { text: lsrText, color: '#c9d1d9' } },
      ]
      if (topPos) values.push({ title: '大户持仓比: ', value: { text: topPos, color: '#ffa726' } })
      return {
        name: '持仓动向',
        calcParamsText: '',
        values,
      }
    },
  } as never)
  registerIndicator(evasiveSuperTrendIndicator as never)
  registerIndicator(nadarayaWatsonIndicator as never)
  registerIndicator(orderBlockIndicator as never)
  registerIndicator(mtfSRIndicator as never)
  registerIndicator(entrySignalIndicator as never)
  registerIndicator(rsiGridIndicator as never)
  // Overlay shapes for the draw primitives. extendData: { color, dashed, label }.
  registerOverlay({
    name: 'tm_hline',
    totalStep: 2,
    lock: true,
    createPointFigures: ({ coordinates, bounding, overlay }: OverlayCreateFiguresCallbackParams) => {
      const y = coordinates[0]?.y
      if (y === undefined) return []
      const ext = (overlay.extendData ?? {}) as Record<string, unknown>
      const color = typeof ext['color'] === 'string' ? ext['color'] : '#888888'
      const figures: unknown[] = [{
        type: 'line',
        attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] },
        styles: { style: typeof ext['dashed'] === 'boolean' && ext['dashed'] ? 'dashed' : 'solid', color },
        ignoreEvent: true,
      }]
      // `lane` comes from the layout pass, which is the only place that can
      // see every line at once: a label drawn here knows its own price and
      // nothing else, so left to itself it lands at the same x as every
      // neighbour and they pile up illegibly.
      const lane = typeof ext['lane'] === 'number' ? ext['lane'] : 0
      // A lane only exists if the pane is wide enough to hold it. The layout
      // pass runs before any geometry is known, so a narrow column could be
      // handed lane 2 and print its caption off the right edge — placed as far
      // as the pass knows, invisible as far as the reader is concerned.
      const usableLanes = Math.max(1, Math.floor((bounding.width - 6) / LABEL_LANE_WIDTH))
      if (lane >= 0 && lane < usableLanes && typeof ext['label'] === 'string' && ext['label'] !== '') {
        figures.push({
          type: 'text',
          attrs: { x: 6 + lane * LABEL_LANE_WIDTH, y: y - 4, text: ext['label'], baseline: 'bottom' },
          styles: labelStyle(color),
          ignoreEvent: true,
        })
      }
      return figures as never
    },
  } as never)
  registerOverlay({
    name: 'tm_region',
    totalStep: 3,
    lock: true,
    createPointFigures: ({ coordinates, bounding, overlay }: OverlayCreateFiguresCallbackParams) => {
      const y0 = coordinates[0]?.y
      const y1 = coordinates[1]?.y
      if (y0 === undefined || y1 === undefined) return []
      const ext = (overlay.extendData ?? {}) as Record<string, unknown>
      const color = typeof ext['color'] === 'string' ? ext['color'] : '#888888'
      const top = Math.min(y0, y1)
      const figures: unknown[] = [{
        type: 'rect',
        attrs: { x: 0, y: top, width: bounding.width, height: Math.abs(y1 - y0) },
        styles: { style: 'fill', color: `${color}26` },
        ignoreEvent: true,
      }]
      // Same lane pass as hlines: a zone edge often shares a price with a
      // scenario trigger, and two captions at x=6 on one y print over each other.
      const lane = typeof ext['lane'] === 'number' ? ext['lane'] : 0
      const usableLanes = Math.max(1, Math.floor((bounding.width - 6) / LABEL_LANE_WIDTH))
      if (lane >= 0 && lane < usableLanes && typeof ext['label'] === 'string' && ext['label'] !== '') {
        figures.push({
          type: 'text',
          attrs: { x: 6 + lane * LABEL_LANE_WIDTH, y: top - 4, text: ext['label'], baseline: 'bottom' },
          styles: labelStyle(color),
          ignoreEvent: true,
        })
      }
      return figures as never
    },
  } as never)
  registerOverlay({
    // totalStep MUST be 2, and 2 is klinecharts' minimum (a lower value is
    // coerced to 1). The library treats an overlay as still being drawn until
    // `points.length >= totalStep - 1`; at 14 a 12-point path (the producer's
    // cap) never finishes, and an unfinished overlay is parked in the store's
    // single in-progress slot rather than the instance list — so only the LAST
    // path ever reaches the chart and the earlier ones vanish while the table
    // below still lists them. Worse, the in-progress path follows the cursor
    // (the mouse-move handler does not check `lock`) and bakes a junk vertex in
    // on every click. Harmless in a chat bubble nobody hovers; permanent in an
    // always-on column. We never draw interactively — drawPrimitive always
    // supplies the whole point list — so finishing immediately loses nothing.
    name: 'tm_polyline',
    totalStep: 2,
    lock: true,
    createPointFigures: ({ coordinates, overlay }: OverlayCreateFiguresCallbackParams) => {
      if (coordinates.length < 2) return []
      const ext = (overlay.extendData ?? {}) as Record<string, unknown>
      const color = typeof ext['color'] === 'string' ? ext['color'] : '#888888'
      const lineCoords = [...coordinates]
      let labelX = coordinates[coordinates.length - 1]!.x + 4
      let labelY = coordinates[coordinates.length - 1]!.y

      // If exactly 2 points (a trendline connecting two swing pivots), extend the ray forward to the right!
      if (coordinates.length === 2 && coordinates[0] && coordinates[1]) {
        const p0 = coordinates[0]
        const p1 = coordinates[1]
        if (Number.isFinite(p0.x) && Number.isFinite(p0.y) && Number.isFinite(p1.x) && Number.isFinite(p1.y)) {
          const dx = p1.x - p0.x
          const dy = p1.y - p0.y
          if (dx > 0) {
            const targetX = p1.x + 800
            const targetY = p1.y + (dy / dx) * (targetX - p1.x)
            if (Number.isFinite(targetY)) {
              lineCoords[1] = { x: targetX, y: targetY }
              labelX = targetX + 4
              labelY = targetY
            }
          }
        }
      }

      const figures: unknown[] = [{
        type: 'line',
        attrs: { coordinates: lineCoords },
        styles: { style: typeof ext['dashed'] === 'boolean' && ext['dashed'] ? 'dashed' : 'solid', color },
        ignoreEvent: true,
      }]
      if (typeof ext['label'] === 'string' && ext['label'] !== '') {
        figures.push({
          type: 'text',
          attrs: { x: labelX, y: labelY, text: ext['label'], baseline: 'middle' },
          styles: labelStyle(color),
          ignoreEvent: true,
        })
      }
      return figures as never
    },
  } as never)
}

function useDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => setDark(e.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return dark
}

function klineStyles(p: Palette): Record<string, unknown> {
  const tick = { color: p.faint, family: FONT_FAMILY }
  return {
    grid: { horizontal: { color: p.line }, vertical: { color: p.line } },
    candle: {
      bar: {
        upColor: p.up, downColor: p.down, noChangeColor: p.faint,
        upBorderColor: p.up, downBorderColor: p.down, noChangeBorderColor: p.faint,
        upWickColor: p.up, downWickColor: p.down, noChangeWickColor: p.faint,
      },
      priceMark: {
        high: { color: p.faint },
        low: { color: p.faint },
        last: { upColor: p.up, downColor: p.down, noChangeColor: p.faint },
      },
      tooltip: { text: { color: p.text, family: FONT_FAMILY }, icons: [FOLD] },
    },
    indicator: { tooltip: { text: { color: p.text, family: FONT_FAMILY }, showRule: 'none' } },
    xAxis: { axisLine: { color: p.line }, tickText: tick, tickLine: { color: p.line } },
    yAxis: { axisLine: { color: p.line }, tickText: tick, tickLine: { color: p.line } },
    separator: { color: p.line },
    crosshair: {
      horizontal: { line: { color: p.faint }, text: { backgroundColor: p.faint, family: FONT_FAMILY } },
      vertical: { line: { color: p.faint }, text: { backgroundColor: p.faint, family: FONT_FAMILY } },
    },
  }
}

/** Map payload series onto klinecharts rows for one chip's figures. */
function seriesRows(data: ChartTimeframeData, figures: Record<string, string>): Record<string, number | undefined>[] {
  return data.candles.map((_, i) => {
    const row: Record<string, number | undefined> = {}
    for (const [figKey, seriesKey] of Object.entries(figures)) {
      const v = data.series?.[seriesKey]?.[i]
      row[figKey] = typeof v === 'number' ? v : undefined
    }
    return row
  })
}

function hasSeries(data: ChartTimeframeData, figures: Record<string, string>): boolean {
  const series = data.series
  if (series === undefined) return false
  return Object.values(figures).every((key) => {
    const col = series[key]
    return Array.isArray(col) && col.length === data.candles.length
  })
}

type ChipDef = {
  id: string
  indicator?: { name: string; figures: Record<string, string>; overlay?: boolean; builtIn?: boolean }
  label: (ind: Record<string, unknown>) => { text: string; state: unknown }
}

/** UI-only translation of the snapshot's state words; the model keeps reading the English originals. */
const ZH_STATE: [RegExp, string][] = [
  [/no seeded moving averages|no seeded wma/g, '均线未成形'], [/above upper band/g, '上轨之上'], [/below lower band/g, '下轨之下'],
  [/inside bands/g, '带内'], [/developing trend/g, '趋势形成中'], [/no trend/g, '无趋势'], [/trending/g, '趋势中'],
  [/overbought/g, '超买'], [/oversold/g, '超卖'], [/neutral/g, '中性'], [/bullish/g, '看多'], [/bearish/g, '看空'],
  [/converging/g, '收敛'], [/flat/g, '走平'], [/support at/g, '支撑'], [/resistance at/g, '阻力'],
  [/above/g, '站上'], [/below/g, '跌破'],
]
export function zhState(s: string): string {
  return ZH_STATE.reduce((acc, [re, zh]) => acc.replace(re, zh), s)
}

const CHIP_DEFS: ChipDef[] = [
  {
    id: 'vol',
    indicator: { name: 'VOL', figures: {}, builtIn: true },
    label: ind => {
      const v = ind['structure'] as Record<string, unknown> | undefined
      const vr = v?.['volume'] as Record<string, unknown> | undefined
      const ratio = vr?.['lastRatio']
      return { text: `VOL${typeof ratio === 'number' ? ` ${ratio}×` : ''}`, state: typeof ratio === 'number' ? (ratio >= 2 ? '放量' : ratio <= 0.5 ? '缩量' : '正常') : '—' }
    },
  },
  {
    id: 'rsi',
    // Same pane as the Pine script: RSI + 累计差值 as lines, 30/60 hlines,
    // fill markers. Computed from the chart's own candles, so it tracks a
    // live column instead of a frozen payload series.
    indicator: { name: 'RSI_GRID', figures: {}, builtIn: true },
    label: ind => {
      const rg = ind['rsiGrid'] as Record<string, unknown> | undefined
      if (!rg) return { text: 'RSI网格', state: '—' }
      const cum = fmt(get(rg, 'cum'))
      const rsiVal = fmt(get(rg, 'rsi'))
      const pos = get(rg, 'position') as Record<string, unknown> | undefined
      let state = '正常'
      if (pos) {
        const pnl = get(pos, 'pnlPct')
        state = `持多${typeof pnl === 'number' ? ` (${pnl >= 0 ? '+' : ''}${pnl}%)` : ''}`
      } else {
        const pending = get(rg, 'pending')
        if (pending === 'entry') state = '触发进多'
        else if (typeof get(rg, 'rsi') === 'number' && (get(rg, 'rsi') as number) < 30) state = '超卖累加中'
      }
      return { text: `RSI7 ${rsiVal} · 差值 ${cum}`, state }
    },
  },
  { id: 'macd', indicator: { name: 'TM_MACD', figures: { hist: 'macd_hist', macd: 'macd', signal: 'macd_signal' } }, label: ind => ({ text: `MACD ${fmt(get(ind['macd'], 'histogram'))}`, state: get(ind['macd'], 'state') }) },
  { id: 'stoch', indicator: { name: 'TM_STOCH', figures: { k: 'stoch_k', d: 'stoch_d' } }, label: ind => ({ text: `随机 ${fmt(get(ind['stochastic'], 'k'))}/${fmt(get(ind['stochastic'], 'd'))}`, state: get(ind['stochastic'], 'state') }) },
  { id: 'adx', indicator: { name: 'TM_ADX', figures: { adx: 'adx', pdi: 'plus_di', mdi: 'minus_di' } }, label: ind => ({ text: `ADX ${fmt(get(ind['adx14'], 'value'))}`, state: get(ind['adx14'], 'state') }) },
  { id: 'mfi', indicator: { name: 'TM_MFI', figures: { mfi: 'mfi14' } }, label: ind => ({ text: `MFI ${fmt(get(ind['mfi14'], 'value'))}`, state: get(ind['mfi14'], 'state') }) },
  { id: 'bb', indicator: { name: 'TM_BB', figures: { upper: 'bb_upper', middle: 'bb_middle', lower: 'bb_lower' }, overlay: true }, label: ind => ({ text: '布林(20,2)', state: get(ind['bollinger20'], 'state') }) },
  { id: 'ma', label: ind => ({ text: '均线位置', state: get(ind['movingAverages'], 'closeVs') }) },
]

/** Horizontal step between label lanes, in px. */
const LABEL_LANE_WIDTH = 150

/** Lanes available before a label is dropped rather than stacked. */
const LABEL_LANES = 3

/**
 * Fraction of the visible price range under which two labels would collide.
 * ~2.5% of the plot height at the label's 10px type size plus breathing room.
 */
const LABEL_MIN_GAP = 0.025

/**
 * Assign each horizontal line a label lane, or -1 to draw the line unlabelled.
 *
 * Ten levels inside a 5% band cannot all be captioned legibly next to their
 * lines — something has to give, and a pile of overlapping text gives the
 * reader nothing while claiming to give them everything. Lines that sit close
 * together step sideways into free lanes; past the last lane the caption is
 * dropped and the line stays. Nothing is lost: the full table, with prices and
 * provenance, is in the chat beside this chart.
 *
 * Placement runs in price space against the window's own range, because the
 * exact pixel scale is not known until the chart lays itself out — an
 * approximation that is deterministic and far better than none.
 *
 * @param prices - line prices, in draw order.
 * @param low - lowest price in the drawn window.
 * @param high - highest price in the drawn window.
 * @returns one lane per input price, aligned by index; -1 means no label.
 */
export function assignLabelLanes(prices: readonly number[], low: number, high: number): number[] {
  const span = high - low
  const lanes = new Array<number>(prices.length).fill(0)
  if (!Number.isFinite(span) || span <= 0) return lanes

  // Sort by price descending so lanes fill the way the eye reads the axis.
  const order = prices.map((price, index) => ({ price, index }))
    .sort((a, b) => b.price - a.price)
  // Last y-position placed in each lane, as a 0..1 fraction of the range.
  // NEGATIVE infinity: an empty lane must accept the first label, and
  // `y - (+Infinity)` is -Infinity, which clears no gap at all.
  const occupied = new Array<number>(LABEL_LANES).fill(Number.NEGATIVE_INFINITY)

  for (const { price, index } of order) {
    const y = (high - price) / span
    let placed = -1
    for (let lane = 0; lane < LABEL_LANES; lane += 1) {
      if (y - occupied[lane]! >= LABEL_MIN_GAP) {
        occupied[lane] = y
        placed = lane
        break
      }
    }
    lanes[index] = placed
  }
  return lanes
}

function drawPrimitive(chart: Pick<Chart, 'createOverlay'>, prim: DrawPrimitive, lane = 0): void {
  if (prim.kind === 'hline') {
    chart.createOverlay({
      name: 'tm_hline', lock: true,
      points: [{ value: prim.price }],
      extendData: { color: prim.color, dashed: prim.dashed ?? false, label: prim.label ?? '', lane },
    })
  } else if (prim.kind === 'region') {
    chart.createOverlay({
      name: 'tm_region', lock: true,
      points: [{ value: prim.low }, { value: prim.high }],
      extendData: { color: prim.color, label: prim.label ?? '', lane },
    })
  } else {
    chart.createOverlay({
      name: 'tm_polyline', lock: true,
      points: prim.points.map(p => ({ timestamp: Date.parse(p.time), value: p.price })),
      extendData: { color: prim.color, dashed: prim.dashed ?? false, label: prim.label ?? '' },
    })
  }
}

function Kline({ data, scenarios, dark, active, seriesKey, settings, onEditParams, derivatives, onCrosshairHover, baseHeight = CHART_HEIGHT, fill = false }: {
  data: ChartTimeframeData
  settings: IndicatorSettings
  onEditParams: () => void
  derivatives?: PanelDerivatives | null | undefined
  onCrosshairHover?: ((timestamp: number | null) => void) | undefined
  scenarios: ChartScenario[]
  dark: boolean
  active: string[]
  /**
   * Identity of the SERIES being drawn — symbol, timeframe, and anything else
   * that means "a different chart". The plot is rebuilt when this changes and
   * only then; a live tail update keeps the same key and rides
   * {@link Chart.updateData} instead, so a polling panel does not tear the
   * canvas down twice a second.
   */
  seriesKey: string
  baseHeight?: number
  /** Take the height the parent flex column leaves, instead of a fixed plot height. */
  fill?: boolean
}): JSX.Element {
  const el = useRef<HTMLDivElement>(null)
  // klinecharts 9.8 keys its instance cache on the container's DOM id and
  // falls back to '' when there is none, so every id-less chart on the page
  // shares one slot: init() then hands back a chart whose container was
  // already unmounted. One id per mount.
  const chartDomId = useRef(`dsh-kline-${++chartDomSeq}`)
  const chartRef = useRef<Chart | null>(null)
  const latest = useRef(data)
  latest.current = data
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const derivativesRef = useRef(derivatives)
  derivativesRef.current = derivatives
  const onEditRef = useRef(onEditParams)
  onEditRef.current = onEditParams
  const onHoverRef = useRef(onCrosshairHover)
  onHoverRef.current = onCrosshairHover
  // 默认收起指标行：浮窗只显示 时间/开高低收，不再挡住图。
  const foldRef = useRef(true)
  const applyFold = (fold: boolean) => {
    chartRef.current?.setStyles({ indicator: { tooltip: { showRule: fold ? TooltipShowRule.None : TooltipShowRule.Always } } })
  }
  const paneCount = active.filter(id => CHIP_DEFS.find(d => d.id === id)?.indicator?.overlay !== true).length
    + EDITABLE.filter(d => d.pane !== undefined && settings[d.name]?.visible).length

  useEffect(() => {
    const container = el.current
    if (container === null) return
    container.id = chartDomId.current
    ensureRegistered()
    const palette = dark ? DARK : LIGHT
    const chart = init(container, { locale: 'zh-CN' })
    if (chart === null) return
    chartRef.current = chart
    const data = latest.current
    chart.setStyles(klineStyles(palette))
    chart.applyNewData(data.candles.map(c => ({
      timestamp: Date.parse(c.time),
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    })))
    for (const def of EDITABLE) {
      const s = settingsRef.current[def.name]!
      if (def.pane !== undefined) {
        // Own pane: created only when shown, so a hidden one doesn't leave a blank strip.
        if (s.visible) chart.createIndicator({ name: def.name, calcParams: s.params }, false, { id: def.pane, height: PANE_HEIGHT })
        continue
      }
      const ext = def.name === 'OI_POSTURE' ? derivativesRef.current?.history : undefined
      chart.createIndicator({ name: def.name, calcParams: s.params, visible: s.visible, extendData: ext }, true, { id: 'candle_pane' })
    }
    chart.subscribeAction(ActionType.OnTooltipIconClick, (d?: { iconId?: string }) => {
      if (d?.iconId === GEAR.id) onEditRef.current()
      if (d?.iconId === FOLD.id) {
        foldRef.current = !foldRef.current
        applyFold(foldRef.current)
      }
    })
    chart.subscribeAction(ActionType.OnCrosshairChange, (d?: { kLineData?: { timestamp?: number } }) => {
      onHoverRef.current?.(d?.kLineData?.timestamp ?? null)
    })
    chart.subscribeAction(ActionType.OnCandleBarClick, (d?: { data?: { timestamp?: number } }) => {
      if (d?.data?.timestamp) onHoverRef.current?.(d.data.timestamp)
    })

    for (const id of active) {
      const def = CHIP_DEFS.find(d => d.id === id)
      if (!def?.indicator) continue
      if (def.indicator.builtIn === true) {
        chart.createIndicator(def.indicator.name, false, { id: `pane_${def.id}`, height: PANE_HEIGHT })
        continue
      }
      if (!hasSeries(data, def.indicator.figures)) continue
      const create = { name: def.indicator.name, extendData: seriesRows(data, def.indicator.figures) }
      if (def.indicator.overlay === true) {
        chart.createIndicator(create, true, { id: 'candle_pane' })
      } else {
        const paneId = `pane_${id}`
        chart.createIndicator(create, false, { id: paneId, height: PANE_HEIGHT })
      }
    }
    const close = data.candles[data.candles.length - 1]!.close
    const ctx: AnnotationRendererContext = { contractVersion: 1, timeframe: data.timeframe, close, palette }
    // Collect every primitive before drawing any: label placement is the one
    // decision that cannot be made one line at a time.
    const primitives: DrawPrimitive[] = []
    for (const annotation of data.annotations ?? []) {
      const renderer = annotationRenderers.get(annotation.type)
      if (renderer === undefined) continue
      try {
        primitives.push(...renderer(annotation, ctx))
      } catch (error) {
        console.warn(`[client-chart] renderer for '${annotation.type}' failed`, error)
      }
    }
    for (const s of scenarios) {
      if (s.triggerPrice !== undefined) primitives.push({ kind: 'hline', price: s.triggerPrice, dashed: true, color: palette.target, label: `${s.direction === 'bull' ? '多' : '空'}·触发` })
      if (s.invalidationPrice !== undefined) primitives.push({ kind: 'hline', price: s.invalidationPrice, dashed: true, color: palette.invalidation, label: `${s.direction === 'bull' ? '多' : '空'}·失效` })
    }
    let lowest = Infinity
    let highest = -Infinity
    for (const c of data.candles) {
      if (c.low < lowest) lowest = c.low
      if (c.high > highest) highest = c.high
    }
    // Every caption pinned to a price — hline labels and zone labels (drawn at
    // the zone's top edge) — goes through one lane pass, so they dodge each other.
    const anchorOf = (prim: DrawPrimitive): number | undefined =>
      prim.kind === 'hline' ? prim.price : prim.kind === 'region' ? Math.max(prim.low, prim.high) : undefined
    const anchors = primitives.map(anchorOf)
    // Fold the captions' own prices into the range. A target above every candle
    // sits outside the candle range, and measuring collisions against a range
    // that excludes it puts it at a fraction beyond 0..1 — comparable, but not
    // to the same scale the chart will use once it makes room for the line.
    for (const a of anchors) {
      if (a === undefined) continue
      if (a < lowest) lowest = a
      if (a > highest) highest = a
    }
    const anchored = anchors.flatMap((a, i) => (a === undefined ? [] : [{ a, i }]))
    const lanes = assignLabelLanes(anchored.map(x => x.a), lowest, highest)
    const laneByIndex = new Map(anchored.map((x, k) => [x.i, lanes[k]!]))
    primitives.forEach((prim, i) => drawPrimitive(chart, prim, laneByIndex.get(i) ?? 0))
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(container)
    return () => {
      observer.disconnect()
      chartRef.current = null
      dispose(container)
    }
    // Deliberately NOT keyed on `data`: see `seriesKey`. Annotation and
    // scenario identity are folded into the key by the caller, so a redraw
    // still happens when the model marks the chart up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesKey, dark, active])

  // Param edits or derivatives update: re-run calc in place; no canvas rebuild.
  useEffect(() => {
    const chart = chartRef.current
    if (chart === null) return
    for (const def of EDITABLE) {
      const s = settings[def.name]!
      if (def.pane !== undefined) {
        const exists = chart.getIndicatorByPaneId(def.pane, def.name) != null
        if (!s.visible) { if (exists) chart.removeIndicator(def.pane, def.name) }
        else if (!exists) chart.createIndicator({ name: def.name, calcParams: s.params }, false, { id: def.pane, height: PANE_HEIGHT })
        else chart.overrideIndicator({ name: def.name, calcParams: s.params }, def.pane)
        continue
      }
      const ext = def.name === 'OI_POSTURE' ? derivatives?.history : undefined
      chart.overrideIndicator({ name: def.name, calcParams: s.params, visible: s.visible, extendData: ext }, 'candle_pane')
    }
  }, [settings, derivatives])

  // Live tail: push the newest bar into the existing plot. klinecharts updates
  // the last bar in place, or appends when the timestamp has moved on, so the
  // same call covers "the current candle ticked" and "a new candle opened".
  useEffect(() => {
    const chart = chartRef.current
    const last = data.candles[data.candles.length - 1]
    if (chart === null || last === undefined) return
    chart.updateData({
      timestamp: Date.parse(last.time),
      open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume,
    })
    for (const id of active) {
      const def = CHIP_DEFS.find(d => d.id === id)
      if (!def?.indicator || def.indicator.builtIn === true || !hasSeries(data, def.indicator.figures)) continue
      chart.overrideIndicator({
        name: def.indicator.name,
        extendData: seriesRows(data, def.indicator.figures),
      })
    }
  }, [data, active])
  // In fill mode the plot is sized by the flex parent and the ResizeObserver
  // above keeps klinecharts in step; `minHeight` is the floor below which a
  // candlestick chart stops being a chart. Indicator panes then divide the
  // available height rather than extending the card downward.
  return fill
    ? <div ref={el} style={{ flex: '1 1 auto', minHeight: 240, width: '100%' }} />
    : <div ref={el} style={{ height: baseHeight + paneCount * PANE_HEIGHT, width: '100%' }} />
}

function fmt(x: unknown): string {
  return typeof x === 'number' && Number.isFinite(x) ? String(x) : '—'
}

function get(x: unknown, key: string): unknown {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>)[key] : undefined
}

const SHELL: CSSProperties = {
  border: '1px solid var(--dsw-alias-border, rgba(128, 128, 128, 0.25))',
  borderRadius: 8,
  padding: 12,
  margin: '4px 0',
  fontSize: 12,
  lineHeight: 1.5,
}

/**
 * A render throw inside the chart used to blank the whole panel, because
 * nothing above ChartBody catches. This keeps the toolbar and prints the
 * error instead. ponytail: class component because React error boundaries
 * still have no hook equivalent; upgrade when one ships.
 */
export class ChartErrorBoundary extends Component<{ children: ReactNode; onReset?: () => void }, { message: string | null }> {
  state = { message: null as string | null }
  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) }
  }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[client-chart] chart render failed', error, info.componentStack)
  }
  override render(): ReactNode {
    return this.state.message === null
      ? this.props.children
      : (
        <Fallback
          text={`图表渲染失败：${this.state.message}`}
          error
          onReset={() => {
            this.setState({ message: null })
            this.props.onReset?.()
          }}
        />
      )
  }
}

function Fallback({ text, error, onReset }: { text: string; error: boolean; onReset?: () => void }): JSX.Element {
  return (
    <div style={SHELL}>
      {onReset !== undefined ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <strong style={{ color: 'var(--dsw-alias-state-error-primary, #e0563f)' }}>图表渲染异常</strong>
          <button
            type="button"
            onClick={onReset}
            style={{
              background: 'transparent',
              border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.3))',
              borderRadius: 4,
              padding: '2px 8px',
              fontSize: 11,
              cursor: 'pointer',
              color: 'inherit',
            }}
          >
            重试
          </button>
        </div>
      ) : null}
      <pre style={{
        margin: 0, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12,
        color: error ? 'var(--dsw-alias-state-error-primary, #e0563f)' : 'inherit',
      }}>{text}</pre>
    </div>
  )
}

function annotationRow(a: ChartAnnotation, close: number, p: Palette): { key: string; color: string; label: string; where: string; distance: string; sources: string } | null {
  const sources = Array.isArray(a['sources']) ? a['sources'].filter((s): s is string => typeof s === 'string').join(' + ') : ''
  const label = str(a['label']) ?? a.type
  const color = roleColor(a['role'], p)
  const pct = (x: number): string => close === 0 ? '' : `${x >= close ? '+' : ''}${(((x - close) / close) * 100).toFixed(2)}%`
  if (a.type === 'level') {
    const price = num(a['price'])
    if (price === undefined) return null
    return { key: `level:${label}:${price}`, color, label, where: String(price), distance: pct(price), sources }
  }
  if (a.type === 'zone') {
    const low = num(a['low'])
    const high = num(a['high'])
    if (low === undefined || high === undefined) return null
    return { key: `zone:${label}:${low}`, color, label, where: `${low} – ${high}`, distance: pct((low + high) / 2), sources }
  }
  if (a.type === 'path') {
    const n = Array.isArray(a['points']) ? a['points'].length : 0
    return { key: `path:${label}`, color, label, where: `${n} 点路径`, distance: '', sources }
  }
  const known = annotationRenderers.has(a.type)
  return { key: `x:${a.type}:${label}`, color: p.faint, label, where: known ? a.type : `${a.type}（无渲染器）`, distance: '', sources }
}

/**
 * The chart itself, driven by a payload and nothing else. Split out of
 * ChartCard so the same body serves two very different seats: the tool-call
 * card inside a chat bubble, and the persistent column of the trading frame.
 * It knows nothing about tool calls, blocks, or slots.
 *
 * @param payload - the durable chart payload to render.
 * @param chartHeight - base plot height in px; the panel gives it more room
 *   than a chat bubble can afford.
 * @param shell - container style, so the panel can drop the card's border and
 *   margins and sit flush in its column.
 */
/**
 * One row per editable indicator: show/hide + its params. Applies on blur or
 * Enter (not per keystroke, so typing "100" never computes WMA(1) and WMA(10)
 * on the way). Shared by every chart on the page and kept across restarts.
 */
function ParamEditor({ settings, palette, onClose }: {
  settings: IndicatorSettings
  palette: Palette
  onClose: () => void
}): JSX.Element {
  const input: CSSProperties = {
    width: 56, background: 'transparent', color: 'inherit', fontSize: 11,
    border: `1px solid ${palette.line}`, borderRadius: 3, padding: '1px 4px',
  }
  const commit = (name: string, i: number, raw: string, el: HTMLInputElement): void => {
    const s = settings[name]!
    const params = [...s.params]
    params[i] = Number(raw)
    const next = sanitizeSettings({ ...settings, [name]: { ...s, params } })
    // Out of range → snap the field back to the value actually in use.
    el.value = String(next[name]!.params[i])
    if (next[name]!.params[i] !== s.params[i]) setSettings(next)
  }
  return (
    <div
      role="group"
      aria-label="指标参数"
      style={{
        display: 'flex', flexDirection: 'column', gap: 6, padding: 8, marginBottom: 8, fontSize: 11,
        border: `1px solid ${palette.line}`, borderRadius: 6, flex: '0 0 auto',
      }}
    >
      {EDITABLE.map(def => {
        const s = settings[def.name]!
        return (
          <div key={def.name} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 84 }}>
              <input
                type="checkbox"
                checked={s.visible}
                onChange={e => setSettings({ ...settings, [def.name]: { ...s, visible: e.target.checked } })}
              />
              {def.title}
            </label>
            {def.params.map((spec, i) => (
              <label key={`${def.name}-${i}-${s.params[i]}`} style={{ display: 'flex', alignItems: 'center', gap: 4, color: palette.faint }}>
                {spec.label}
                <input
                  type="number"
                  defaultValue={s.params[i]}
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  style={input}
                  onBlur={e => commit(def.name, i, e.target.value, e.target)}
                  onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
                />
              </label>
            ))}
          </div>
        )
      })}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => setSettings(sanitizeSettings(null))}
          style={{ background: 'transparent', color: palette.faint, border: `1px solid ${palette.line}`, borderRadius: 4, fontSize: 11, cursor: 'pointer' }}
        >恢复默认</button>
        <button
          onClick={onClose}
          style={{ background: 'transparent', color: 'inherit', border: `1px solid ${palette.line}`, borderRadius: 4, fontSize: 11, cursor: 'pointer' }}
        >收起</button>
      </div>
    </div>
  )
}

const CHIPS_STORAGE_KEY = 'dsh-trading.active-chips.v2'
function getInitialActiveChips(): string[] {
  try {
    const raw = localStorage.getItem(CHIPS_STORAGE_KEY)
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        return arr.filter(id => typeof id === 'string' && CHIP_DEFS.some(d => d.id === id))
      }
    }
  } catch {}
  return ['vol', 'rsi']
}

export function ChartBody({ payload, chartHeight = CHART_HEIGHT, shell = SHELL, fill = false, prose = true, derivatives, onCrosshairHover }: {
  payload: ChartPayload
  chartHeight?: number
  shell?: CSSProperties
  fill?: boolean
  prose?: boolean
  derivatives?: PanelDerivatives | null
  onCrosshairHover?: (timestamp: number | null) => void
}): JSX.Element {
  const dark = useDark()
  const [activeTf, setActiveTf] = useState(0)
  const [activeChips, setActiveChips] = useState<string[]>(getInitialActiveChips)
  const settings = useSyncExternalStore(subscribeSettings, getSettings)
  const [editing, setEditing] = useState(false)

  const rawTf = payload.timeframes[Math.min(activeTf, payload.timeframes.length - 1)]
  const tf = useMemo(() => {
    if (!rawTf) return undefined
    if (rawTf.indicators !== null && rawTf.series !== undefined && rawTf.series['rsi14']?.length === rawTf.candles.length) {
      return rawTf
    }
    try {
      const indicators = rawTf.indicators ?? (rawTf.candles.length > 0 ? regimeSnapshot(rawTf.candles) : null)
      const series = rawTf.series ?? (rawTf.candles.length > 0 ? regimeSeries(rawTf.candles) : undefined)
      return { ...rawTf, indicators, series }
    } catch {
      return rawTf
    }
  }, [rawTf])
  const activeKey = useMemo(() => [...activeChips].sort().join(','), [activeChips])
  const activeList = useMemo(() => activeKey === '' ? [] : activeKey.split(','), [activeKey])
  const scenarios = useMemo(() => payload.scenarios ?? [], [payload])

  if (tf === undefined) {
    return <Fallback text={`${payload.symbol}: no timeframes in payload`} error={false} />
  }

  const last = tf.candles[tf.candles.length - 1]!
  const first = tf.candles[0]!
  const changePct = get(tf.indicators, 'changePct')
  const palette = dark ? DARK : LIGHT
  const toggle = (id: string): void =>
    setActiveChips(prev => {
      let next: string[]
      if (prev.includes(id)) {
        next = prev.filter(x => x !== id)
      } else {
        next = [...prev, id]
      }
      try { localStorage.setItem(CHIPS_STORAGE_KEY, JSON.stringify(next)) } catch {}
      return next
    })

  const chipRow = tf.indicators === null ? [] : CHIP_DEFS.flatMap((def) => {
    const { text, state } = def.label(tf.indicators!)
    if (typeof state !== 'string' || state === '') return []
    const togglable = def.indicator !== undefined && (def.indicator.builtIn === true || hasSeries(tf, def.indicator.figures))
    return [{ id: def.id, text: `${text} · ${zhState(state)}`, togglable, on: activeChips.includes(def.id) }]
  })

  const rows = (tf.annotations ?? [])
    .map(a => annotationRow(a, last.close, palette))
    .filter((r): r is NonNullable<typeof r> => r !== null)

  // What counts as "a different chart" for rebuild purposes: the instrument,
  // the interval, and the exact marks drawn on it. A tail tick changes none of
  // these, which is why a live poll does not rebuild the canvas — `withCandles`
  // spreads `{ ...tf, candles }`, so the annotations array keeps its identity.
  //
  // Deliberately a plain call, not a useMemo: these lines sit after an early
  // return, and a hook past a conditional return breaks the rules of hooks.
  // The series' LEFT EDGE is in the key too. Without it, swapping one window
  // for another of the same instrument, interval and marks — exactly what
  // happens when the panel replaces the agent's 200-bar payload with the
  // user's 1000-bar series — produces a byte-identical key, so the init effect
  // never re-runs, applyNewData is never called, and the canvas keeps the old
  // candles under the new caption. A live tail cannot change this value:
  // mergeTail only replaces the forming bar or appends a new one.
  const seriesKey = `${payload.provider}|${payload.symbol}|${tf.timeframe}|${tf.candles[0]?.time ?? ''}|${annotationDigest(tf.annotations, scenarios)}`

  const root: CSSProperties = fill
    ? { ...shell, display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }
    : shell

  return (
    <div style={root}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8, marginBottom: 8, flex: '0 0 auto' }}>
        <strong style={{ fontSize: 13 }}>{payload.symbol}</strong>
        <span style={{ color: palette.faint }}>{tf.timeframe} · {tf.candles.length} 根 · {payload.provider}</span>
        <span>收 {last.close}</span>
        {typeof changePct === 'number' && Number.isFinite(changePct)
          ? <span style={{ color: changePct >= 0 ? palette.up : palette.down }}>
              {changePct >= 0 ? '+' : ''}{changePct}%
            </span>
          : null}
        <button
          onClick={() => setEditing(e => !e)}
          aria-expanded={editing}
          style={{
            marginLeft: 'auto', border: `1px solid ${editing ? palette.text : palette.line}`,
            background: 'transparent', color: 'inherit', borderRadius: 4,
            padding: '1px 8px', fontSize: 11, cursor: 'pointer',
          }}
        >⚙ 指标参数</button>
        {payload.timeframes.length > 1
          ? <span style={{ display: 'flex', gap: 4 }}>
              {payload.timeframes.map((t, i) => (
                <button
                  key={t.timeframe}
                  onClick={() => setActiveTf(i)}
                  style={{
                    border: `1px solid ${i === activeTf ? palette.text : palette.line}`,
                    background: 'transparent', color: 'inherit', borderRadius: 4,
                    padding: '1px 8px', fontSize: 11, cursor: 'pointer',
                  }}
                >{t.timeframe}</button>
              ))}
            </span>
          : null}
      </div>
      {editing ? <ParamEditor settings={settings} palette={palette} onClose={() => setEditing(false)} /> : null}
      <Kline
        key={seriesKey}
        data={tf}
        scenarios={scenarios}
        dark={dark}
        active={activeList}
        seriesKey={seriesKey}
        settings={settings}
        derivatives={derivatives}
        onCrosshairHover={onCrosshairHover}
        onEditParams={() => setEditing(true)}
        baseHeight={chartHeight}
        fill={fill}
      />
      <div style={fill ? { flex: '0 1 auto', minHeight: 0, overflowY: 'auto' } : undefined}>
      {chipRow.length > 0
        ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {chipRow.map(chip => chip.togglable
              ? <button
                  key={chip.id}
                  onClick={() => toggle(chip.id)}
                  aria-pressed={chip.on}
                  style={{
                    border: `1px solid ${chip.on ? palette.up : palette.line}`,
                    background: chip.on ? `${palette.up}22` : 'transparent',
                    color: chip.on ? palette.up : palette.text,
                    borderRadius: 99, padding: '1px 8px', fontSize: 11, cursor: 'pointer',
                  }}
                >{chip.text}</button>
              : <span
                  key={chip.id}
                  style={{
                    border: `1px solid ${palette.line}`, borderRadius: 99,
                    padding: '1px 8px', fontSize: 11, color: palette.faint,
                  }}
                >{chip.text}</span>)}
          </div>
        : null}
      {prose && rows.length > 0
        ? <table style={{ width: '100%', marginTop: 10, borderCollapse: 'collapse', fontSize: 11.5 }}>
            <tbody>
              {rows.map(row => (
                <tr key={row.key} style={{ borderTop: `1px solid ${palette.line}` }}>
                  <td style={{ padding: '4px 8px 4px 0', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 99, background: row.color, marginRight: 6 }} />
                    {row.label}
                  </td>
                  <td style={{ padding: '4px 8px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{row.where}</td>
                  <td style={{ padding: '4px 8px', whiteSpace: 'nowrap', color: palette.faint, fontVariantNumeric: 'tabular-nums' }}>{row.distance}</td>
                  <td style={{ padding: '4px 0 4px 8px', color: palette.faint }}>{row.sources}</td>
                </tr>
              ))}
            </tbody>
          </table>
        : null}
      {prose && scenarios.length > 0
        ? <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
            {scenarios.map((s, i) => (
              <div
                key={i}
                style={{
                  borderLeft: `3px solid ${s.direction === 'bull' ? palette.up : palette.down}`,
                  background: `${s.direction === 'bull' ? palette.up : palette.down}11`,
                  borderRadius: 4, padding: '6px 10px',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 2 }}>
                  <span style={{ color: s.direction === 'bull' ? palette.up : palette.down }}>
                    {s.direction === 'bull' ? '看多' : '看空'}
                  </span>
                  <span style={{
                    marginLeft: 6, fontSize: 10, letterSpacing: 0.5, color: palette.faint,
                    border: `1px solid ${palette.line}`, borderRadius: 3, padding: '0 4px',
                  }}>{s.stance === 'base' ? '主' : '备'}</span>
                  <span style={{ marginLeft: 8, fontWeight: 400 }}>{s.thesis}</span>
                </div>
                <div style={{ color: palette.faint, fontSize: 11 }}>
                  触发：{s.trigger}{s.triggerPrice !== undefined ? ` (${s.triggerPrice})` : ''}
                  {' · '}失效：{s.invalidation}{s.invalidationPrice !== undefined ? ` (${s.invalidationPrice})` : ''}
                </div>
              </div>
            ))}
          </div>
        : null}
      <div style={{ color: palette.faint, marginTop: 6, fontSize: 11 }}>
        {first.time} … {last.time} · 点击标签开关对应指标副图
        {prose ? ' · 情景为研究假设，非交易建议' : ''}
      </div>
      </div>
    </div>
  )
}

/**
 * The tool-call seat's adapter: unwrap a `market_snapshot` / `get_ohlcv` /
 * `annotate_chart` result into a payload and hand it to {@link ChartBody},
 * degrading to the rendered text when the payload is absent.
 *
 * It also PUBLISHES each payload it sees to the latest-chart store, which is
 * what lifts the model's chart out of the chat bubble and into the frame's
 * persistent column. Publishing from render (via an effect) rather than from
 * the tool pipeline keeps the seam one-directional: the panel never reaches
 * into conversation state, it just mirrors whatever card rendered last.
 */
export function ChartCard(props: ToolCallViewProps): JSX.Element {
  const { block, toolName } = props
  const settled = 'kind' in block
  const payload = settled && !block.isError ? readChartPayload(block.meta) : null

  useEffect(() => {
    if (payload !== null) publishLatestChart(payload)
  }, [payload])

  if (!settled) {
    return <div style={SHELL}>{toolName} …</div>
  }
  if (block.isError) {
    return <Fallback text={contentText(block.content) || `${toolName} failed`} error />
  }
  if (payload === null) {
    return <Fallback text={contentText(block.content)} error={false} />
  }
  return <ChartBody payload={payload} />
}
