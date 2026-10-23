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
import { ActionType, dispose, init, registerIndicator, registerOverlay, utils } from 'klinecharts'
import type { Chart, KLineData, YAxisType } from 'klinecharts'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { publishLatestChart } from './latest.js'
import { annotationDigest, contentText, readChartPayload } from './payload.js'
import type { ChartAnnotation, ChartPayload, ChartScenario, ChartTimeframeData } from './payload.js'
import type { PanelDerivativeBar, PanelDerivatives, PanelLargeOrders } from './market-client.js'
import { contractOpenInterest, postureColor } from './market-client.js'
import { regimeSnapshot } from '../../../tool-market/src/regime.js'
import { rsiGridStateText } from '../../../tool-market/src/rsi-grid.js'
import type { RsiGridReport } from '../../../tool-market/src/rsi-grid.js'
import { regimeSeries } from '../../../tool-market/src/chart-payload.js'
import { evasiveSuperTrend, evasiveSuperTrendIndicator } from './indicators/evasive-st.js'
import { nadarayaWatsonIndicator, NW_ALERTS, NW_COLOR_PRESETS, NW_DEFAULTS, NW_KERNELS, NW_PRESET_NAMES, NW_SOURCES, migrateNwParams, nwAlertEvents } from './indicators/nadaraya-watson.js'
import { orderBlockBreaker, orderBlockIndicator } from './indicators/order-blocks.js'
import { calculateVbProRead, enabledVbAlerts, intToHex, VB_ALERTS, VB_DEFAULTS, vbProReadIndicator } from './indicators/vb-pro-read.js'
import { dualViewHtfIndicator, DV_DEFAULTS, PATTERN_KEYS, PATTERN_CN, HTF_TF_LABELS, PATTERN_FILTER_OPTS, SIZE_OPTS, TREND_OPTS, dvAlertEvents } from './indicators/dual-view-htf-patterns.js'
import { mtfSRZones, mtfSRIndicator, mtfSourceTimeframeSeconds } from './indicators/mtf-sr.js'
import { entrySignalIndicator } from './indicators/entry-signal.js'
import { rsiGridIndicator, rsiGridCumIndicator, rsiGridMarksIndicator } from './indicators/rsi-grid.js'
import { revPointIndicator, REVPOINT_TABLE_W } from './indicators/revpoint.js'
import { kPatternIndicator, KP_ALERT, KP_ALERTS, KP_BEAR_INDICES, KP_BG_COLOR, KP_BG_ON, KP_BULL_INDICES, KP_COLOR, KP_DEFAULTS, KP_FONT, KP_FORMING, KP_LABEL_MODES, KP_LAST, KP_MODE, KP_PLOTS, KP_SHOW, KP_THEME, kpAlertEvents } from './indicators/aicoin-kpattern.js'
import { aicoinTdIndicator, aicoinTdMarksIndicator, TD_DEFAULTS, TD_MARK_RESERVE, TD_MODES, tdAlertEvents, tdWantsMarks, tdWantsPane } from './indicators/aicoin-td.js'
import { ohlcOffsetRightForTopLeft } from './indicators/revpoint-layout.js'
import { detectPricePrecision, formatPrice } from './precision.js'
import { createAnnotationOverlays } from './annotation-overlays.js'
import { createMainPaneTooltipFold, SUBPLOT_TOOLTIP } from './indicator-tooltip.js'

export { evasiveSuperTrend } from './indicators/evasive-st.js'
export { nadarayaWatsonTrend } from './indicators/nadaraya-watson.js'
export { orderBlockBreaker } from './indicators/order-blocks.js'
export { mtfSRZones } from './indicators/mtf-sr.js'

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 })

function formatUsdtCnLocal(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(1)}万`
  if (abs < 0.5) return `${sign}0`
  return `${sign}${abs.toFixed(0)}`
}
let chartDomSeq = 0

const CHART_HEIGHT = 320
const PANE_HEIGHT = 90

/**
 * klinecharts defaults to 'Helvetica Neue', which Windows lacks — CJK captions
 * then fall back to whatever the canvas picks. Name real UI faces per platform.
 */
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif'

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

/** AiCoin TD: sub-pane lines (source plot) and/or numbers on the candles, per its 显示方式 param. */
function syncAicoinTd(chart: Chart, s: { params: number[]; visible: boolean }, dark: boolean): void {
  const p = dark ? DARK : LIGHT
  const ext = { up: p.up, down: p.down }
  const sync = (want: boolean, name: string, paneId: string, isStack: boolean): void => {
    const has = chart.getIndicatorByPaneId(paneId, name) != null
    if (!want) { if (has) chart.removeIndicator(paneId, name); return }
    if (has) chart.overrideIndicator({ name, calcParams: s.params, extendData: ext }, paneId)
    else chart.createIndicator({ name, calcParams: s.params, extendData: ext }, isStack, paneId === 'candle_pane' ? { id: paneId } : { id: paneId, height: PANE_HEIGHT })
  }
  sync(s.visible && tdWantsPane(s.params), 'AICOIN_TD', 'pane_aicoin_td', false)
  sync(s.visible && tdWantsMarks(s.params), 'AICOIN_TD_MARKS', 'candle_pane', true)
}

/** Chart theme handed to the AiCoin ports (their colours follow the candles unless the user turns it off). */
function kpThemeExt(dark: boolean, settings: IndicatorSettings): { up: string; down: string; bg: string; reserve: number } {
  const p = dark ? DARK : LIGHT
  const td = settings['AICOIN_TD']
  const tdOnCandles = td !== undefined && td.visible && tdWantsMarks(td.params)
  return { up: p.up, down: p.down, bg: dark ? 'rgba(13, 17, 23, 0.85)' : 'rgba(255, 255, 255, 0.9)', reserve: tdOnCandles ? TD_MARK_RESERVE : 0 }
}

/* ------------------------------------------------------------------ */
/* Open annotation-renderer registry (the ecosystem seam)              */
/* ------------------------------------------------------------------ */

export type DrawPrimitive =
  | { kind: 'hline'; price: number; label?: string; color?: string; dashed?: boolean }
  | { kind: 'region'; low: number; high: number; label?: string; color?: string; startTime?: string; availableAt?: string }
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
  return [{ kind: 'region', low, high, color: roleColor(a['role'], ctx.palette),
    ...str(a['label']) !== undefined ? { label: str(a['label'])! } : {},
    ...str(a['startTime']) !== undefined ? { startTime: str(a['startTime'])! } : {},
    ...str(a['availableAt']) !== undefined ? { availableAt: str(a['availableAt'])! } : {},
  }]
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

/** kind: number (default) | select (options[i] ↔ value i) | bool (0/1 checkbox) | color (0xRRGGBB int). */
type ParamSpec = { label: string; min: number; max: number; step: number; kind?: 'number' | 'select' | 'bool' | 'color'; options?: string[] }
const boolP = (label: string): ParamSpec => ({ label, min: 0, max: 1, step: 1, kind: 'bool' })
const colorP = (label: string): ParamSpec => ({ label, min: 0, max: 0xFFFFFF, step: 1, kind: 'color' })
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
  // 1:1 with pine/nadaraya-watson.pine inputs L31-49 (same order), then one toggle per alertcondition L159-163.
  { name: 'NW_TREND', title: '核回归趋势(QuantAlgo)', defaults: [...NW_DEFAULTS], defaultVisible: false, params: [
    { label: '预设配置', min: 0, max: 2, step: 1, kind: 'select', options: [...NW_PRESET_NAMES] },
    { label: '源', min: 0, max: NW_SOURCES.length - 1, step: 1, kind: 'select', options: [...NW_SOURCES] },
    { label: '核类型', min: 0, max: NW_KERNELS.length - 1, step: 1, kind: 'select', options: [...NW_KERNELS] },
    { label: '回溯窗口', min: 1, max: 500, step: 1 }, { label: '核带宽', min: 1, max: 1000, step: 1 },
    { label: '带宽倍数', min: 0.1, max: 100, step: 0.1 }, { label: '相对权重(RQ)', min: 0.1, max: 100, step: 0.25 },
    boolP('显示残差带'), { label: '带倍数', min: 0.1, max: 100, step: 0.1 },
    boolP('显示渐变填充'), boolP('显示反转标记'),
    { label: '颜色预设', min: 0, max: 5, step: 1, kind: 'select', options: [...NW_COLOR_PRESETS] },
    colorP('看涨色'), colorP('看跌色'),
    boolP('启用K线着色'), { label: 'K线着色透明度', min: 0, max: 100, step: 1 },
    boolP('启用背景着色'), { label: '背景着色透明度', min: 0, max: 100, step: 1 },
    ...NW_ALERTS.map(a => boolP(`提醒:${a.cn}`)),
  ] },
  { name: 'OB_BB', title: '订单块/破坏块(RWB)', defaults: [5, 5, 20], defaultVisible: false, params: [period('Swing左'), period('Swing右'), period('等待K线')] },
  { name: 'VB_PRO_READ', title: '波动带Pro-Read(Indicatr)', defaults: [...VB_DEFAULTS], defaultVisible: false, params: [
    { label: '带类型', min: 0, max: 2, step: 1, kind: 'select', options: ['布林', '肯特纳', '唐奇安'] }, { label: '周期', min: 2, max: 500, step: 1 }, { label: '布林倍数', min: 0.1, max: 20, step: 0.1 }, { label: '肯特纳ATR倍数', min: 0.1, max: 20, step: 0.1 },
    { label: '走带回看', min: 2, max: 500, step: 1 }, { label: '走带最少收盘', min: 1, max: 500, step: 1 }, { label: '外区位置', min: 0.5, max: 1, step: 0.05 }, { label: 'ADX周期', min: 2, max: 500, step: 1 }, { label: 'ADX趋势阈值', min: 1, max: 100, step: 0.5 },
    boolP('显示挤压'), boolP('标均值回归'), colorP('走带上/多'), colorP('走带下/空'), colorP('中性'),
    ...VB_ALERTS.map(a => boolP(`提醒:${a.cn}`)),
  ] },
  { name: 'DUAL_VIEW_HTF', title: '双视HTF形态(theUltimator5)', defaults: [...DV_DEFAULTS], defaultVisible: false, params: [
    { label: '高周期', min: 0, max: 9, step: 1, kind: 'select', options: [...HTF_TF_LABELS] },
    { label: '浮动K数量', min: 1, max: 10, step: 1 }, { label: 'K宽度(bars)', min: 1, max: 100, step: 1 },
    { label: 'K间距', min: 0, max: 50, step: 1 }, { label: '右缘偏移', min: 0, max: 200, step: 1 },
    { label: '历史回看(HTF)', min: 10, max: 300, step: 1 },
    boolP('显示浮动HTF'), boolP('历史形态画到图上'),
    colorP('多实体'), colorP('多边框'), colorP('空实体'), colorP('空边框'),
    { label: '实体透明度', min: 0, max: 100, step: 1 }, { label: '线宽', min: 1, max: 10, step: 1 },
    boolP('显示趋势线'), colorP('MA颜色'), { label: 'MA线宽', min: 1, max: 5, step: 1 },
    { label: '趋势算法', min: 0, max: 1, step: 1, kind: 'select', options: [...TREND_OPTS] },
    { label: 'MA周期', min: 1, max: 200, step: 1 },
    { label: '形态筛选', min: 0, max: 2, step: 1, kind: 'select', options: [...PATTERN_FILTER_OPTS] },
    ...PATTERN_KEYS.map(k => boolP(PATTERN_CN[k])),
    { label: '文字大小', min: 0, max: 3, step: 1, kind: 'select', options: [...SIZE_OPTS] },
    boolP('显示ⓘ说明'), colorP('多标签色'), colorP('空标签色'),
    { label: 'Doji敏感度', min: 0.01, max: 0.5, step: 0.01 },
    boolP('中心周期标签'), colorP('中心标签色'),
    { label: '中心标签大小', min: 0, max: 3, step: 1, kind: 'select', options: [...SIZE_OPTS] },
    { label: '标签下偏移', min: 0, max: 20, step: 1 },
    boolP('水平参考线'), colorP('参考线色'), { label: '参考线宽', min: 1, max: 5, step: 1 },
    boolP('提醒:HTF形态'),
  ] },
  { name: 'MTF_SR', title: '多周期支撑阻力(Syndicate)', defaults: [5], defaultVisible: false, params: [period('Pivot周期')] },
  // 1:1 with the AiCoin K线形态 script: one show+colour per plotText (source order), plotText fontSize/bgColor, one toggle per alertcondition.
  { name: 'AICOIN_KPATTERN', title: 'K线形态(AiCoin)', defaults: [...KP_DEFAULTS], defaultVisible: false, params: [
    ...KP_PLOTS.map(p => boolP(p.title)),
    ...KP_PLOTS.map(p => colorP(p.title + '色')),
    { label: '字号', min: 6, max: 40, step: 1 }, boolP('文字背景'), colorP('背景色'),
    ...KP_ALERTS.map(a => boolP('提醒:' + a.title + (a.direction === 'buy' ? '(买)' : '(卖)'))),
    // Plugin-side display (not in the AiCoin script): theme colours, collision-avoiding labels, forming bar, showLast.
    boolP('跟随主题配色'), { label: '标签模式', min: 0, max: KP_LABEL_MODES.length - 1, step: 1, kind: 'select', options: [...KP_LABEL_MODES] },
    boolP('标注未收盘K线'), { label: '只看最近N根(0全部)', min: 0, max: 5000, step: 1 },
  ] },
  // 1:1 with the AiCoin TD script: plot(up,"UP") / plot(dn,"Down") — display, color, linewidth.
  { name: 'AICOIN_TD', title: 'TD计数(AiCoin)', pane: 'pane_aicoin_td', defaults: [...TD_DEFAULTS], defaultVisible: false, params: [
    boolP('显示UP'), colorP('UP色'), { label: 'UP线宽', min: 1, max: 10, step: 1 },
    boolP('显示Down'), colorP('Down色'), { label: 'Down线宽', min: 1, max: 10, step: 1 },
    // Plugin-side display: numbers on the candles (classic TD look) and/or the source's sub-pane lines.
    { label: '显示方式', min: 0, max: TD_MODES.length - 1, step: 1, kind: 'select', options: [...TD_MODES] },
    boolP('跟随主题配色'), { label: '数字起始', min: 1, max: 99, step: 1 }, boolP('突出9/13'),
    boolP('提醒:计数9'), boolP('提醒:计数13'),
  ] },
  { name: 'RSI_GRID', title: 'RSI网格（多空）', pane: 'pane_rsi_grid', defaults: [7, 30, 60, 10], params: [period('RSI周期'), period('多入阈值'), period('多平阈值'), period('累计阈值')] },
  { name: 'REVPOINT', title: '反转点标注 RevPoint', defaults: [0.7, 2.0, 3, 0, 0, 1, 0, 1, 0], params: [{ label: '细档确认阈值%', min: 0.1, max: 10, step: 0.1 }, { label: '粗档(大周期)阈值%', min: 0.5, max: 20, step: 0.1 }, { label: '多周期pivot左右bar数', min: 1, max: 10, step: 1 }, { label: '15m(0/1)', min: 0, max: 1, step: 1 }, { label: '30m(0/1)', min: 0, max: 1, step: 1 }, { label: '1H(0/1)', min: 0, max: 1, step: 1 }, { label: '2H(0/1)', min: 0, max: 1, step: 1 }, { label: '4H(0/1)', min: 0, max: 1, step: 1 }, { label: '细档最少★数', min: 0, max: 4, step: 1 }] },
  { name: 'OI_POSTURE', title: '合约OI', pane: 'pane_oi_posture', defaults: [], params: [] },
  { name: 'LSR_RATIO', title: '多空比', pane: 'pane_lsr', defaults: [], params: [] },
  { name: 'ENTRY_SIGNAL', title: '多空观察信号(未验证)', defaults: [60, 4], defaultVisible: false, params: [period('ST周期'), { label: 'ST倍数', min: 0.1, max: 20, step: 0.1 }] },
  { name: 'LARGE_WALLS', title: '大单墙(CoinGlass)', defaults: [100, 20, 8], defaultVisible: false, params: [
    { label: '最低金额(万)', min: 0, max: 3000, step: 1 },
    { label: '距离现价(%)', min: 1, max: 100, step: 1 },
    { label: '单边展示条数', min: 2, max: 20, step: 1 },
  ] },
]

export type IndicatorSettings = Record<string, { params: number[]; visible: boolean }>

/** Trust boundary (localStorage is user-editable): anything off-spec falls back to its default, per field. */
export function sanitizeSettings(raw: unknown): IndicatorSettings {
  const src = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  return Object.fromEntries(EDITABLE.map(def => {
    const e = src[def.name]
    const entry = typeof e === 'object' && e !== null ? e as { params?: unknown; visible?: unknown } : {}
    const raw: unknown[] = Array.isArray(entry.params) ? entry.params : []
    // NW_TREND used to store [lookback, bandwidth, h_mult, band_mult]; keep the user's values.
    const given = def.name === 'NW_TREND' ? migrateNwParams(raw) : raw
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

/** Read current indicator visibility/params (for panel features like 大单墙). */
export function peekSettings(): IndicatorSettings {
  return getSettings()
}

/** Subscribe to indicator settings changes. */
export function subscribeSettings(fn: () => void): () => void {
  settingsListeners.add(fn)
  return () => { settingsListeners.delete(fn) }
}

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

export type CoordType = 'normal' | 'percentage' | 'log'

export interface AxisSettings {
  coordType: CoordType
  autoScale: {
    candle: boolean
    rsi: boolean
    accLs: boolean
    macd: boolean
  }
}

export const DEFAULT_AXIS_SETTINGS: AxisSettings = {
  coordType: 'normal',
  autoScale: {
    candle: true,
    rsi: true,
    accLs: true,
    macd: true,
  },
}

export function toYAxisType(coord: CoordType): YAxisType {
  if (coord === 'percentage') return 'percentage' as YAxisType
  if (coord === 'log') return 'log' as YAxisType
  return 'normal' as YAxisType
}

export function sanitizeAxisSettings(raw: unknown): AxisSettings {
  const src = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const rawCoord = typeof src['coordType'] === 'string' ? src['coordType'] : 'normal'
  const coordType: CoordType = (rawCoord === 'percentage' || rawCoord === 'log') ? rawCoord : 'normal'
  const rawAuto = typeof src['autoScale'] === 'object' && src['autoScale'] !== null ? src['autoScale'] as Record<string, unknown> : {}
  return {
    coordType,
    autoScale: {
      candle: typeof rawAuto['candle'] === 'boolean' ? rawAuto['candle'] : true,
      rsi: typeof rawAuto['rsi'] === 'boolean' ? rawAuto['rsi'] : true,
      accLs: typeof rawAuto['accLs'] === 'boolean' ? rawAuto['accLs'] : true,
      macd: typeof rawAuto['macd'] === 'boolean' ? rawAuto['macd'] : true,
    },
  }
}

const AXIS_SETTINGS_KEY = 'dsh-trading.chart-axis-settings.v1'
let axisSettingsCache: AxisSettings | undefined
const axisSettingsListeners = new Set<() => void>()

export function getAxisSettings(): AxisSettings {
  if (axisSettingsCache === undefined) {
    let raw: unknown = null
    try { raw = JSON.parse(localStorage.getItem(AXIS_SETTINGS_KEY) ?? 'null') } catch {}
    axisSettingsCache = sanitizeAxisSettings(raw)
  }
  return axisSettingsCache
}

export function setAxisSettings(next: AxisSettings): void {
  axisSettingsCache = sanitizeAxisSettings(next)
  try { localStorage.setItem(AXIS_SETTINGS_KEY, JSON.stringify(axisSettingsCache)) } catch {}
  for (const l of axisSettingsListeners) l()
}

export function subscribeAxisSettings(l: () => void): () => void {
  axisSettingsListeners.add(l)
  return () => { axisSettingsListeners.delete(l) }
}

/**
 * Resolves the candle pane's Y-axis component from a klinecharts Chart instance.
 */
export function getCandleYAxis(chart: Chart | null): any {
  // klinecharts exposes no public Y-axis handle in 9.x; these are internals.
  // Every hop is feature-detected and the whole lookup is fenced, so a library
  // upgrade that renames them degrades Y-zoom/reset instead of white-screening.
  if (!chart) return null
  try {
    const anyChart = chart as any
    const pane = typeof anyChart.getDrawPaneById === 'function'
      ? anyChart.getDrawPaneById('candle_pane')
      : anyChart._candlePane
    const axis = typeof pane?.getAxisComponent === 'function' ? pane.getAxisComponent() : null
    return axis ?? null
  } catch {
    return null
  }
}

/** Set the candle Y-axis auto-calc flag; false when the internal API is missing. */
export function setCandleYAxisAutoCalc(chart: Chart | null, flag: boolean): boolean {
  const yAxis = getCandleYAxis(chart)
  if (yAxis === null || typeof yAxis.setAutoCalcTickFlag !== 'function') return false
  try { yAxis.setAutoCalcTickFlag(flag); return true } catch { return false }
}

/** Read the candle Y-axis auto-calc flag; null when unknown. */
export function getCandleYAxisAutoCalc(chart: Chart | null): boolean | null {
  const yAxis = getCandleYAxis(chart)
  if (yAxis === null || typeof yAxis.getAutoCalcTickFlag !== 'function') return null
  try { return Boolean(yAxis.getAutoCalcTickFlag()) } catch { return null }
}

/** Ask the chart to re-layout its panes (internal); silently no-ops if absent. */
export function adjustChartViewport(chart: Chart | null): void {
  if (!chart) return
  try {
    const anyChart = chart as any
    if (typeof anyChart.adjustPaneViewport === 'function') anyChart.adjustPaneViewport(false, true, true, true, true)
  } catch { /* degrade */ }
}

/**
 * Resets the candle pane Y-axis to auto calculation and refreshes the viewport.
 */
export function resetCandleYAxisAuto(chart: Chart | null): void {
  if (!chart) return
  setCandleYAxisAutoCalc(chart, true)
  adjustChartViewport(chart)
}

/** Legend cog on the editable indicators; a click opens the param row (ActionType.OnTooltipIconClick). */
const GEAR = {
  id: 'params', position: 'right', icon: '⚙', size: 12, fontFamily: 'Segoe UI Symbol, Apple Symbols, sans-serif',
  color: '#8b949e', activeColor: '#c9d1d9', backgroundColor: 'transparent', activeBackgroundColor: 'rgba(139,148,158,0.2)',
  marginLeft: 4, marginTop: 4, marginRight: 4, marginBottom: 4, paddingLeft: 2, paddingTop: 0, paddingRight: 2, paddingBottom: 0,
}

/** 折叠十字线浮窗里的指标行，只留 时间/开高低收，点一下在“收起/展开”之间切换。 */
/** Enabled VB alerts on the latest closed bar (second to last; last is forming). */
export function vbAlertEvents(candles: readonly { time: string; high: number; low: number; close: number }[], params: readonly number[]): { id: string; text: string }[] {
  if (candles.length < 2) return []
  const rows = calculateVbProRead(candles, params)
  const i = candles.length - 2
  return enabledVbAlerts(rows[i], params).map(a => ({ id: `${candles[i]!.time}|${a.key}`, text: `${a.cn} · ${a.msg} (${candles[i]!.time})` }))
}

export const FOLD_EXEMPT: ReadonlySet<string> = new Set(["VB_PRO_READ"])

const FOLD = {
  id: 'fold', position: 'right', icon: '▤', size: 12, fontFamily: 'Segoe UI Symbol, Apple Symbols, sans-serif',
  color: '#8b949e', activeColor: '#c9d1d9', backgroundColor: 'transparent', activeBackgroundColor: 'rgba(139,148,158,0.2)',
  marginLeft: 4, marginTop: 4, marginRight: 4, marginBottom: 4, paddingLeft: 2, paddingTop: 0, paddingRight: 2, paddingBottom: 0,
}

let registered = false


/**
 * Match a derivative history bar to a candle open time.
 * - No interval (or ≤15m): nearest 5m snapshot within 15 minutes.
 * - Larger candles (1h/4h/1d): the LAST snapshot inside [open, open+interval) —
 *   a 1d candle otherwise almost never lines up with a 5m snapshot.
 */
export function matchDerivativeHistory(
  history: PanelDerivativeBar[],
  timestampMs: number,
  intervalMs?: number,
): PanelDerivativeBar | undefined {
  if (intervalMs !== undefined && intervalMs > 900_000) {
    let best: PanelDerivativeBar | undefined
    let bestT = -Infinity
    for (const h of history) {
      const t = Date.parse(h.time)
      if (!Number.isFinite(t) || t < timestampMs || t >= timestampMs + intervalMs) continue
      if (t > bestT) { bestT = t; best = h }
    }
    return best
  }
  const kSec = Math.floor(timestampMs / 1000)
  let bestDiff = Infinity
  let matched: PanelDerivativeBar | undefined
  for (const h of history) {
    const sec = Math.floor(Date.parse(h.time) / 1000)
    if (!Number.isFinite(sec)) continue
    const diff = Math.abs(sec - kSec)
    if (diff < bestDiff && diff <= 900) {
      bestDiff = diff
      matched = h
    }
  }
  return matched
}

/** Candle spacing from the first two bars; undefined when it cannot be read. */
export function inferIntervalMs(kLineDataList: { timestamp?: number }[]): number | undefined {
  const a = kLineDataList[0]?.timestamp
  const b = kLineDataList[1]?.timestamp
  return a !== undefined && b !== undefined && b > a ? b - a : undefined
}

export type OiPostureRow = {
  oi?: number
  oiMa?: number
  deltaOi?: number
  bar?: PanelDerivativeBar
}

/** OI_POSTURE subplot series: coin OI + MA. Ratios live in tooltip/chips and LSR_RATIO pane. */
export function calcOiPostureRows(
  kLineDataList: { timestamp?: number }[],
  history: PanelDerivativeBar[],
  maPeriod = 14,
): OiPostureRow[] {
  if (!Array.isArray(history) || history.length === 0) {
    return kLineDataList.map(() => ({}))
  }
  const deltas = history.map((h, idx) => {
    const prev = idx > 0 ? history[idx - 1] : undefined
    const curVal = contractOpenInterest(h)
    const prevVal = prev ? contractOpenInterest(prev) : null
    return curVal !== null && prevVal !== null ? curVal - prevVal : undefined
  })
  const oiValues: (number | undefined)[] = []
  return kLineDataList.map(k => {
    const ts = k.timestamp
    if (ts === undefined) {
      oiValues.push(undefined)
      return {}
    }
    const bar = matchDerivativeHistory(history, ts, inferIntervalMs(kLineDataList))
    if (!bar) {
      oiValues.push(undefined)
      return {}
    }
    const histIdx = history.indexOf(bar)
    const oi = contractOpenInterest(bar)
    if (oi === null) {
      oiValues.push(undefined)
      return {}
    }
    oiValues.push(oi)
    let sum = 0
    let count = 0
    for (let j = oiValues.length - 1; j >= 0 && count < maPeriod; j--) {
      const val = oiValues[j]
      if (val !== undefined) {
        sum += val
        count++
      }
    }
    const row: OiPostureRow = { oi, bar }
    if (count > 0) row.oiMa = sum / count
    const delta = deltas[histIdx]
    if (delta !== undefined) row.deltaOi = delta
    return row
  })
}

export type LsrRatioRow = {
  lsr?: number
  topPos?: number
  topAcc?: number
  mid?: number
  bar?: PanelDerivativeBar
}

/**
 * LSR_RATIO subplot: account long/short ratio + top-trader position ratio + top-trader account ratio.
 * mid=1 is the net-long / net-short boundary (>1 净多).
 */
export function calcLsrRatioRows(
  kLineDataList: { timestamp?: number }[],
  history: PanelDerivativeBar[],
): LsrRatioRow[] {
  if (!Array.isArray(history) || history.length === 0) {
    return kLineDataList.map(() => ({}))
  }
  return kLineDataList.map(k => {
    const ts = k.timestamp
    if (ts === undefined) return {}
    const bar = matchDerivativeHistory(history, ts, inferIntervalMs(kLineDataList))
    if (!bar) return {}
    const row: LsrRatioRow = { mid: 1, bar }
    if (bar.longShortRatio != null && Number.isFinite(bar.longShortRatio)) {
      row.lsr = bar.longShortRatio
    }
    if (bar.topPositionRatio != null && Number.isFinite(bar.topPositionRatio)) {
      row.topPos = bar.topPositionRatio
    }
    if (bar.topAccountRatio != null && Number.isFinite(bar.topAccountRatio)) {
      row.topAcc = bar.topAccountRatio
    }
    if (row.lsr === undefined && row.topPos === undefined && row.topAcc === undefined) return {}
    return row
  })
}

const DERIV_HISTORY_INDICATORS = new Set(['OI_POSTURE', 'LSR_RATIO', 'REVPOINT'])


/** Distinct, non-gray subplot palette (works on dark + light; up/down match candles). */
export const SUBPLOT_COLORS = {
  up: '#3ddc97', upFade: '#1f7a55', down: '#f47067', downFade: '#8f3f3a',
  blue: '#58a6ff', orange: '#ffa726', purple: '#b083f0', yellow: '#e3b341', cyan: '#27C6DA',
} as const

/** TradingView-style 4-shade MACD histogram: bright when growing away from 0, dim when fading. */
export function macdHistColor(cur: number | undefined, prev: number | undefined): string {
  if (cur === undefined || !Number.isFinite(cur)) return SUBPLOT_COLORS.upFade
  const growing = prev === undefined || !Number.isFinite(prev) || Math.abs(cur) >= Math.abs(prev)
  if (cur >= 0) return growing ? SUBPLOT_COLORS.up : SUBPLOT_COLORS.upFade
  return growing ? SUBPLOT_COLORS.down : SUBPLOT_COLORS.downFade
}

type HistNeighbor = { indicatorData?: { hist?: number } }
export function macdHistStyles(data: { prev?: HistNeighbor; current?: HistNeighbor }): Record<string, unknown> {
  const color = macdHistColor(data.current?.indicatorData?.hist, data.prev?.indicatorData?.hist)
  return { color, borderColor: color, style: 'fill' }
}

function ensureRegistered(): void {
  if (registered) return
  registered = true
  // Data rides extendData, not calcParams: klinecharts prints calcParams into
  // the pane's tooltip title, which would render as "[object Object]" spam.
  const passthrough = (_dl: unknown[], ind: { extendData: unknown }): unknown[] =>
    ind.extendData as unknown[]
  const line = (key: string, title: string, color: string, size = 1.5): { key: string; title: string; type: string; styles: () => Record<string, unknown> } =>
    ({ key, title: `${title}: `, type: 'line', styles: () => ({ color, size }) })
  const defs: { name: string; shortName: string; calcParams: number[]; precision?: number; figures: { key: string; title: string; type: string; baseValue?: number; styles?: unknown }[] }[] = [
    { name: 'TM_RSI', shortName: 'RSI', calcParams: [14], figures: [line('rsi', 'RSI', SUBPLOT_COLORS.purple)] },
    { name: 'TM_STOCH', shortName: 'STOCH', calcParams: [14, 3, 3], figures: [line('k', 'K', SUBPLOT_COLORS.blue), line('d', 'D', SUBPLOT_COLORS.orange)] },
    { name: 'TM_ADX', shortName: 'ADX', calcParams: [14], figures: [line('adx', 'ADX', SUBPLOT_COLORS.yellow, 2), line('pdi', '+DI', SUBPLOT_COLORS.up), line('mdi', '-DI', SUBPLOT_COLORS.down)] },
    { name: 'TM_MACD', shortName: 'MACD', calcParams: [12, 26, 9], precision: 4, figures: [{ key: 'hist', title: '柱: ', type: 'bar', baseValue: 0, styles: macdHistStyles }, line('macd', 'MACD', SUBPLOT_COLORS.blue), line('signal', '信号', SUBPLOT_COLORS.orange)] },
    { name: 'TM_MFI', shortName: 'MFI', calcParams: [14], figures: [line('mfi', 'MFI', SUBPLOT_COLORS.cyan)] },
    { name: 'TM_BB', shortName: '布林', calcParams: [20, 2], figures: [line('upper', '上', SUBPLOT_COLORS.down, 1), line('middle', '中', SUBPLOT_COLORS.yellow, 1), line('lower', '下', SUBPLOT_COLORS.up, 1)] },
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
        values: v === undefined ? [] : [{ title: '', value: { text: formatPrice(v), color: ST_COLORS[row?.up !== undefined ? 0 : 1] } }],
        icons: [GEAR],
      }
    },
  } as never)

  registerIndicator({
    name: 'OI_POSTURE',
    shortName: '合约OI',
    series: 'volume',
    precision: 2,
    shouldFormatBigNumber: true,
    calcParams: [14],
    figures: [
      {
        key: 'oi',
        title: '币数: ',
        type: 'line',
        styles: () => ({
          color: '#27C6DA',
          size: 1.5,
        }),
      },
      {
        key: 'oiMa',
        title: 'OI均线: ',
        type: 'line',
        styles: () => ({
          color: '#f59e0b',
          size: 1,
        }),
      },
    ],
    calc: (kLineDataList: { timestamp?: number }[], indicator: { extendData?: unknown; calcParams?: number[] }) => {
      const history = (indicator.extendData ?? []) as PanelDerivativeBar[]
      const maPeriod = (indicator.calcParams?.[0] as number | undefined) ?? 14
      return calcOiPostureRows(kLineDataList, history, maPeriod)
    },
    createTooltipDataSource: ({ indicator, crosshair, kLineDataList }: {
      indicator: { calcParams?: number[]; extendData?: unknown; result?: Record<string, unknown>[] }
      crosshair: { dataIndex?: number; kLineData?: { timestamp?: number } }
      kLineDataList: { timestamp?: number }[]
    }) => {
      const res = indicator.result ?? []
      const history = (indicator.extendData ?? []) as PanelDerivativeBar[]
      if (!Array.isArray(history) || history.length === 0) {
        return { name: '合约OI', calcParamsText: '', values: [] }
      }
      const dataIndex = crosshair.dataIndex ?? (kLineDataList.length - 1)
      const row = res[dataIndex] as OiPostureRow | undefined
      const ts = crosshair.kLineData?.timestamp ?? kLineDataList[dataIndex]?.timestamp

      let target: PanelDerivativeBar | undefined = row?.bar
      let deltaVal: number | undefined = row?.deltaOi
      if (!target && ts !== undefined) {
        target = matchDerivativeHistory(history, ts, inferIntervalMs(kLineDataList))
      }
      // Strictly prevent time-travel leakage: only fallback to latest live snapshot on the newest candle
      if (!target && dataIndex >= kLineDataList.length - 1) {
        target = history[history.length - 1]
      }

      if (!target) {
        return {
          name: '合约OI',
          calcParamsText: '',
          values: [
            { title: '币数: ', value: { text: '—', color: '#8b949e' } },
            { title: '动向: ', value: { text: '历史无快照', color: '#8b949e' } },
          ],
        }
      }

      const postureText = target.quadrant
        ? `${target.quadrant}${target.quadrantNote ? `（${target.quadrantNote}）` : ''}`
        : target.posture
      const pColor = postureColor(postureText).color
      const oiContracts = contractOpenInterest(target)
      const oiText = oiContracts !== null ? compact.format(oiContracts) : '—'
      const lsrText = target.longShortRatio != null ? target.longShortRatio.toFixed(2) : '—'
      const topPos = target.topPositionRatio != null ? target.topPositionRatio.toFixed(2) : null
      const tkText = target.takerBuySellRatio != null ? target.takerBuySellRatio.toFixed(2) : null
      const deltaText = deltaVal !== undefined && Number.isFinite(deltaVal)
        ? `${deltaVal >= 0 ? '+' : ''}${compact.format(deltaVal)}`
        : null

      const values: { title: string; value: { text: string; color: string } }[] = [
        { title: '币数: ', value: { text: oiText, color: '#27C6DA' } },
        { title: 'OI名义: ', value: { text: target.openInterestValue ? formatUsdtCnLocal(target.openInterestValue) : '—', color: '#8b949e' } },
      ]
      if (row?.oiMa !== undefined && Number.isFinite(row.oiMa)) {
        values.push({ title: 'OI均线: ', value: { text: compact.format(row.oiMa), color: '#f59e0b' } })
      }
      if (deltaText) {
        values.push({ title: 'Δ币数: ', value: { text: deltaText, color: deltaVal! >= 0 ? '#22c55e' : '#ef4444' } })
      }
      values.push({ title: '动向: ', value: { text: postureText ?? '—', color: pColor } })
      if (tkText) {
        values.push({ title: '主动买卖: ', value: { text: tkText, color: Number(tkText) >= 1.0 ? '#22c55e' : '#ef4444' } })
      }
      values.push({ title: '账户人数比: ', value: { text: lsrText, color: '#c9d1d9' } })
      if (topPos) {
        values.push({ title: '大户持仓比: ', value: { text: topPos, color: '#ffa726' } })
      }
      const p = indicator.calcParams?.[0] ?? 14
      return {
        name: '合约OI',
        calcParamsText: `(${p})`,
        values,
      }
    },
  } as never)

  registerIndicator({
    name: 'LSR_RATIO',
    shortName: '多空比',
    series: 'normal',
    precision: 2,
    shouldFormatBigNumber: false,
    calcParams: [],
    figures: [
      {
        key: 'lsr',
        title: '账户人数比: ',
        type: 'line',
        styles: () => ({ color: '#58a6ff', size: 1.5 }),
      },
      {
        key: 'topPos',
        title: '大户持仓比: ',
        type: 'line',
        styles: () => ({ color: '#ffa726', size: 1.5 }),
      },
      {
        key: 'topAcc',
        title: '大户账户比: ',
        type: 'line',
        styles: () => ({ color: '#b083f0', size: 1.5 }),
      },
      {
        key: 'mid',
        title: '中性1: ',
        type: 'line',
        styles: () => ({ color: '#768390', size: 1, style: 'dashed', dashedValue: [4, 3] }),
      },
    ],
    styles: {
      lines: [
        { color: '#58a6ff', size: 1.5, style: 'solid', smooth: false, dashedValue: [2, 2] },
        { color: '#ffa726', size: 1.5, style: 'solid', smooth: false, dashedValue: [2, 2] },
        { color: '#b083f0', size: 1.5, style: 'solid', smooth: false, dashedValue: [2, 2] },
        { color: '#768390', size: 1, style: 'dashed', smooth: false, dashedValue: [4, 3] },
      ],
    },
    calc: (kLineDataList: { timestamp?: number }[], indicator: { extendData?: unknown }) => {
      const history = (indicator.extendData ?? []) as PanelDerivativeBar[]
      return calcLsrRatioRows(kLineDataList, history)
    },
    createTooltipDataSource: ({ indicator, crosshair, kLineDataList }: {
      indicator: { extendData?: unknown; result?: Record<string, unknown>[] }
      crosshair: { dataIndex?: number; kLineData?: { timestamp?: number } }
      kLineDataList: { timestamp?: number }[]
    }) => {
      const res = indicator.result ?? []
      const history = (indicator.extendData ?? []) as PanelDerivativeBar[]
      if (!Array.isArray(history) || history.length === 0) {
        return { name: '多空比', calcParamsText: '', values: [] }
      }
      const dataIndex = crosshair.dataIndex ?? (kLineDataList.length - 1)
      const row = res[dataIndex] as LsrRatioRow | undefined
      const ts = crosshair.kLineData?.timestamp ?? kLineDataList[dataIndex]?.timestamp
      let target: PanelDerivativeBar | undefined = row?.bar
      if (!target && ts !== undefined) target = matchDerivativeHistory(history, ts, inferIntervalMs(kLineDataList))
      if (!target && dataIndex >= kLineDataList.length - 1) target = history[history.length - 1]
      if (!target) {
        return {
          name: '多空比',
          calcParamsText: '',
          values: [{ title: '说明: ', value: { text: '无历史比值', color: '#8b949e' } }],
        }
      }
      const ratioTag = (v: number | null | undefined) => {
        if (v == null || !Number.isFinite(v)) return ''
        if (v > 1) return '(>1净多)'
        if (v < 1) return '(<1净空)'
        return '(=1)'
      }
      const lsr = target.longShortRatio
      const topPos = target.topPositionRatio
      const topAcc = target.topAccountRatio
      const values: { title: string; value: { text: string; color: string } }[] = [
        {
          title: '账户人数比: ',
          value: {
            text: lsr != null ? `${lsr.toFixed(2)}${ratioTag(lsr)}` : '—',
            color: '#58a6ff',
          },
        },
        {
          title: '大户持仓比: ',
          value: {
            text: topPos != null ? `${topPos.toFixed(2)}${ratioTag(topPos)}` : '—',
            color: '#ffa726',
          },
        },
      ]
      if (topAcc != null) {
        values.push({
          title: '大户账户比: ',
          value: {
            text: `${topAcc.toFixed(2)}${ratioTag(topAcc)}`,
            color: '#b083f0',
          },
        })
      }
      values.push({ title: '中性线: ', value: { text: '1.00', color: '#768390' } })
      return { name: '多空比', calcParamsText: '', values }
    },
  } as never)
  registerIndicator(evasiveSuperTrendIndicator as never)
  registerIndicator(nadarayaWatsonIndicator as never)
  registerIndicator(orderBlockIndicator as never)
  registerIndicator(vbProReadIndicator as never)
  registerIndicator(dualViewHtfIndicator as never)
  registerIndicator(mtfSRIndicator as never)
  registerIndicator(entrySignalIndicator as never)
  registerIndicator(rsiGridIndicator as never)
  registerIndicator(rsiGridCumIndicator as never)
  registerIndicator(rsiGridMarksIndicator as never)
  registerIndicator(revPointIndicator as never)
registerIndicator(kPatternIndicator as never)
registerIndicator(aicoinTdIndicator as never)
registerIndicator(aicoinTdMarksIndicator as never)
  // Overlay shapes for the draw primitives. extendData: { color, dashed, label }.
  // Register exactly the callbacks exercised by the overlay regression tests.
  for (const overlay of createAnnotationOverlays(FONT_FAMILY, (text, style) =>
    utils.calcTextWidth(text, style.size, style.weight, style.family))) {
    registerOverlay(overlay)
  }
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

/**
 * When the crosshair is on the left half, klinecharts parks the fixed OHLC box
 * at the top-right — exactly where RevPoint's status table is pinned. Push the
 * right-parked box left of the table (statusTableRect geometry).
 */
export function ohlcTooltipAvoidTable(revPointOn: boolean, paneW = 0): Record<string, unknown> {
  // Table + edge pills own the top-right: park the OHLC box top-left on both halves.
  return { candle: { tooltip: { rect: { offsetRight: revPointOn && paneW > 0 ? ohlcOffsetRightForTopLeft(paneW) : 4 } } } }
}

export function klineStyles(p: Palette, coordType: CoordType = 'normal'): Record<string, unknown> {
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
      tooltip: {
        showType: 'rect',
        text: { color: p.text, family: FONT_FAMILY },
        icons: [FOLD],
        rect: {
          position: 'fixed',
          paddingLeft: 6, paddingRight: 6, paddingTop: 4, paddingBottom: 4,
          offsetLeft: 4, offsetTop: 4, offsetRight: 4, offsetBottom: 4,
          borderRadius: 4, borderSize: 1,
          borderColor: p.line,
          color: p.text === '#c9d1d9' ? 'rgba(22,27,34,0.92)' : 'rgba(255,255,255,0.92)',
        },
      },
    },
    indicator: {
      tooltip: {
        ...SUBPLOT_TOOLTIP,
        text: { color: p.text, family: FONT_FAMILY },
      },
    },
    xAxis: { axisLine: { color: p.line }, tickText: tick, tickLine: { color: p.line } },
    yAxis: { axisLine: { color: p.line }, tickText: tick, tickLine: { color: p.line }, type: toYAxisType(coordType) },
    separator: { color: p.line },
    crosshair: {
      horizontal: { line: { color: p.faint }, text: { backgroundColor: p.faint, family: FONT_FAMILY } },
      vertical: { line: { color: p.faint }, text: { backgroundColor: p.faint, family: FONT_FAMILY } },
    },
  }
}

/**
 * Fill missing regime snapshot + per-bar series on a timeframe (live panel path).
 * Agent cards already ship both; live `candlesToPayload` leaves them empty on
 * purpose so the model is not blamed for client-invented numbers — the card
 * still needs series for MACD/Stoch/ADX/MFI/BB chips, so we compute locally.
 */
export function enrichChartTimeframe(tf: ChartTimeframeData): ChartTimeframeData {
  if (tf.candles.length === 0) return tf
  const seriesOk = tf.series !== undefined
    && tf.series['rsi14']?.length === tf.candles.length
  if (tf.indicators !== null && seriesOk) return tf
  try {
    const indicators = tf.indicators ?? regimeSnapshot(tf.candles)
    const series = seriesOk ? tf.series : regimeSeries(tf.candles)
    return { ...tf, indicators, series }
  } catch {
    return tf
  }
}

/** Map payload series onto klinecharts rows for one chip's figures. */
export function seriesRows(data: ChartTimeframeData, figures: Record<string, string>): Record<string, number | undefined>[] {
  return data.candles.map((_, i) => {
    const row: Record<string, number | undefined> = {}
    for (const [figKey, seriesKey] of Object.entries(figures)) {
      const v = data.series?.[seriesKey]?.[i]
      row[figKey] = typeof v === 'number' && Number.isFinite(v) ? v : undefined
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
      const sg = ind['rsiGridShort'] as Record<string, unknown> | undefined
      const cum = fmt(get(rg, 'cum'))
      const shortCum = get(sg, 'cum')
      const rsiVal = fmt(get(rg, 'rsi'))
      const params = get(rg, 'params')
      const length = Array.isArray(params) ? params[0] : 7
      const longState = rsiGridStateText({ ...rg, side: 'long' } as unknown as RsiGridReport)
      const shortState = sg ? rsiGridStateText({ ...sg, side: 'short' } as unknown as RsiGridReport) : '—'
      return { text: `RSI${length} ${rsiVal} · 多差 ${cum} / 空差 ${typeof shortCum === 'number' ? fmt(shortCum === 0 ? 0 : -shortCum) : '—'}`,
        state: `多·${longState} / 空·${shortState}` }
    },
  },
  { id: 'macd', indicator: { name: 'TM_MACD', figures: { hist: 'macd_hist', macd: 'macd', signal: 'macd_signal' } }, label: ind => ({ text: `MACD ${fmt(get(ind['macd'], 'histogram'))}`, state: get(ind['macd'], 'state') }) },
  { id: 'stoch', indicator: { name: 'TM_STOCH', figures: { k: 'stoch_k', d: 'stoch_d' } }, label: ind => ({ text: `随机 ${fmt(get(ind['stochastic'], 'k'))}/${fmt(get(ind['stochastic'], 'd'))}`, state: get(ind['stochastic'], 'state') }) },
  { id: 'adx', indicator: { name: 'TM_ADX', figures: { adx: 'adx', pdi: 'plus_di', mdi: 'minus_di' } }, label: ind => ({ text: `ADX ${fmt(get(ind['adx14'], 'value'))}`, state: get(ind['adx14'], 'state') }) },
  { id: 'mfi', indicator: { name: 'TM_MFI', figures: { mfi: 'mfi14' } }, label: ind => ({ text: `MFI ${fmt(get(ind['mfi14'], 'value'))}`, state: get(ind['mfi14'], 'state') }) },
  { id: 'bb', indicator: { name: 'TM_BB', figures: { upper: 'bb_upper', middle: 'bb_middle', lower: 'bb_lower' }, overlay: true }, label: ind => ({ text: '布林(20,2)', state: get(ind['bollinger20'], 'state') }) },
  { id: 'ma', label: ind => ({ text: '均线位置', state: get(ind['movingAverages'], 'closeVs') }) },
]

/** Lanes available before a label is dropped rather than stacked. */
const LABEL_LANES = 4

/**
 * Fraction of the visible price range under which two labels would collide.
 * ~2.5% of the plot height at the label's 10px type size plus breathing room.
 */
const LABEL_MIN_GAP = 0.06

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
export function assignLabelLanes(prices: readonly number[], low: number, high: number, coordType: CoordType = 'normal'): number[] {
  // On a log axis the screen distance is proportional to ln(price), so measure
  // collisions there; non-positive prices cannot be placed on it → linear.
  const useLog = coordType === 'log' && low > 0 && prices.every(p => p > 0)
  const tx = useLog ? Math.log : (v: number) => v
  const top = tx(high)
  const span = top - tx(low)
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
    const y = (top - tx(price)) / span
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
      points: [
        { value: prim.low, ...prim.startTime !== undefined ? { timestamp: Date.parse(prim.startTime) } : {} },
        { value: prim.high, ...prim.startTime !== undefined ? { timestamp: Date.parse(prim.startTime) } : {} },
        ...prim.availableAt !== undefined ? [{ timestamp: Date.parse(prim.availableAt), value: prim.high }] : [],
      ],
      extendData: { color: prim.color, label: prim.label ?? '', lane,
        anchored: prim.startTime !== undefined, knownAfterConfirmation: prim.availableAt !== undefined },
    })
  } else {
    chart.createOverlay({
      name: 'tm_polyline', lock: true,
      points: prim.points.map(p => ({ timestamp: Date.parse(p.time), value: p.price })),
      extendData: { color: prim.color, dashed: prim.dashed ?? false, label: prim.label ?? '' },
    })
  }
}

/** One payload candle as a klinecharts row. */
function toKLine(c: { time: string; open: number; high: number; low: number; close: number; volume: number }): KLineData {
  return { timestamp: Date.parse(c.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }
}

/** Older-bar paging contract between the panel and the canvas. */
export interface ChartHistory {
  /** Fetch bars strictly older than `beforeMs`, ascending. */
  load: (beforeMs: number) => Promise<ChartTimeframeData['candles']>
  /** Merge the bars the canvas just prepended into the payload's series. */
  commit: (older: ChartTimeframeData['candles']) => void
}

/**
 * Diff the wanted chip set against what is mounted on the canvas.
 * @param active - chip ids the user has on.
 * @param mounted - chip ids currently on the canvas.
 * @param mountable - whether a chip can be drawn right now (has series etc.).
 */
export function planChipSync(active: readonly string[], mounted: ReadonlyMap<string, string> | ReadonlySet<string>, mountable: (id: string) => boolean): { add: string[]; remove: string[] } {
  const want = new Set(active.filter(mountable))
  const have = new Set(mounted.keys())
  return { add: [...want].filter(id => !have.has(id)), remove: [...have].filter(id => !want.has(id)) }
}

function Kline({ data, scenarios, dark, active, seriesKey, settings, axisSettings, onEditParams, derivatives, largeWalls, onCrosshairHover, history, baseHeight = CHART_HEIGHT, fill = false }: {
  data: ChartTimeframeData
  /** Older-bar paging for klinecharts loadMore; absent on agent cards. */
  history?: ChartHistory | undefined
  settings: IndicatorSettings
  axisSettings: AxisSettings
  onEditParams: () => void
  derivatives?: PanelDerivatives | null | undefined
  largeWalls?: PanelLargeOrders | null | undefined
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
  const ohlcParkCleanup = useRef<(() => void) | null>(null)
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
  const wallOverlayIds = useRef<string[]>([])
  const annotationOverlayIds = useRef<string[]>([])
  /** Chip indicators currently mounted on the canvas: chip id → pane id. */
  const mountedChips = useRef(new Map<string, string>())
  const historyRef = useRef(history)
  historyRef.current = history
  // 默认只收起主图指标行，副图名称和数值保持可见。
  const foldRef = useRef(true)
  const paneCount = active.filter(id => CHIP_DEFS.find(d => d.id === id)?.indicator?.overlay !== true).length
    + EDITABLE.filter(d => d.pane !== undefined && settings[d.name]?.visible && (d.name !== 'AICOIN_TD' || tdWantsPane(settings[d.name]!.params))).length
    // RSI_GRID also mounts the 累计差值 pane under it.
    + (settings['RSI_GRID']?.visible ? 1 : 0)

  useEffect(() => {
    const container = el.current
    if (container === null) return
    container.id = chartDomId.current
    ensureRegistered()
    const palette = dark ? DARK : LIGHT
    const chart = init(container, { locale: 'zh-CN' })
    if (chart === null) return
    chartRef.current = chart
    const applyFold = createMainPaneTooltipFold(chart, FOLD_EXEMPT)
    const data = latest.current
    chart.setStyles(klineStyles(palette, axisSettings.coordType))
    const applyOhlcPark = () => chart.setStyles(ohlcTooltipAvoidTable(settingsRef.current['REVPOINT']?.visible ?? false, chart.getSize('candle_pane', 'main' as never)?.width ?? 0))
    applyOhlcPark()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(applyOhlcPark) : null
    ro?.observe(container)
    ohlcParkCleanup.current = () => ro?.disconnect()
    chart.setPaneOptions({
      id: 'candle_pane',
      gap: axisSettings.autoScale.candle ? { top: 0.08, bottom: 0.05 } : { top: 0.2, bottom: 0.1 },
      axisOptions: { scrollZoomEnabled: true },
    })
    const pricePrec = detectPricePrecision(data.candles)
    chart.setPriceVolumePrecision(pricePrec, 0)
    chart.applyNewData(data.candles.map(c => ({
      timestamp: Date.parse(c.time),
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    })))
    for (const def of EDITABLE) {
      if (def.name === 'LARGE_WALLS') continue // overlay drawn from CoinGlass RPC, not a klinecharts indicator
      const s = settingsRef.current[def.name]!
      const ext = DERIV_HISTORY_INDICATORS.has(def.name) ? derivativesRef.current?.history
        : def.name === 'MTF_SR' || def.name === 'DUAL_VIEW_HTF' ? { sourceTimeframe: data.timeframe, sourceTimeframeSeconds: mtfSourceTimeframeSeconds(data.timeframe) }
        : def.name === 'AICOIN_KPATTERN' ? kpThemeExt(dark, settingsRef.current) : undefined
      if (def.name === 'AICOIN_TD') { syncAicoinTd(chart, s, dark); continue }
      if (def.pane !== undefined) {
        // Own pane: created only when shown, so a hidden one doesn't leave a blank strip.
        if (s.visible) {
          chart.createIndicator({ name: def.name, calcParams: s.params, extendData: ext }, false, { id: def.pane, height: PANE_HEIGHT })
          if (def.name === 'RSI_GRID') {
            chart.createIndicator({ name: 'RSI_GRID_CUM', calcParams: s.params }, false, { id: 'pane_rsi_cum', height: PANE_HEIGHT })
            chart.createIndicator({ name: 'RSI_GRID_MARKS', calcParams: s.params }, true, { id: 'candle_pane' })
          }
        }
        continue
      }
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

    // History paging: klinecharts fires this when the user drags to the left edge.
    if (typeof (chart as any).loadMore === 'function') {
      chart.loadMore((timestamp) => {
        const h = historyRef.current
        if (h === undefined || timestamp == null) { chart.applyMoreData([], false); return }
        h.load(timestamp).then(
          (older) => {
            if (chartRef.current !== chart) return
            const rows = older.filter(c => Date.parse(c.time) < timestamp)
            if (rows.length === 0) { chart.applyMoreData([], false); return }
            chart.applyMoreData(rows.map(toKLine), true)
            h.commit(rows)
          },
          () => { if (chartRef.current === chart) chart.applyMoreData([], false) },
        )
      })
    }
    applyFold(foldRef.current)
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(container)
    return () => {
      observer.disconnect()
      chartRef.current = null
      mountedChips.current = new Map()
      annotationOverlayIds.current = []
      ohlcParkCleanup.current?.()
      dispose(container)
    }
    // Deliberately NOT keyed on `data`: see `seriesKey`. Annotation and
    // scenario identity are folded into the key by the caller, so a redraw
    // still happens when the model marks the chart up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesKey, dark])

  // Agent marks + scenario lines. Own effect so a coordType change can re-run
  // label placement without tearing the canvas (and the viewport) down.
  useEffect(() => {
    const chart = chartRef.current
    if (chart === null) return
    for (const id of annotationOverlayIds.current) {
      try { chart.removeOverlay({ id }) } catch { /* gone */ }
    }
    annotationOverlayIds.current = []
    const data = latest.current
    if (data.candles.length === 0) return
    const palette = dark ? DARK : LIGHT
    const created: string[] = []
    const sink = { createOverlay: (o: Parameters<Chart['createOverlay']>[0]) => {
      const id = chart.createOverlay(o)
      if (typeof id === 'string' && id) created.push(id)
      return id
    } } as Pick<Chart, 'createOverlay'>
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
      if (s.triggerPrice !== undefined) {
        const dup = primitives.some(p => p.kind === 'hline' && Math.abs(p.price - s.triggerPrice!) / s.triggerPrice! < 0.005)
        if (!dup) primitives.push({ kind: 'hline', price: s.triggerPrice, dashed: true, color: palette.target, label: `${s.direction === 'bull' ? '多' : '空'}·触发` })
      }
      if (s.invalidationPrice !== undefined) {
        const dup = primitives.some(p => p.kind === 'hline' && Math.abs(p.price - s.invalidationPrice!) / s.invalidationPrice! < 0.005)
        if (!dup) primitives.push({ kind: 'hline', price: s.invalidationPrice, dashed: true, color: palette.invalidation, label: `${s.direction === 'bull' ? '多' : '空'}·失效` })
      }
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
    const lanes = assignLabelLanes(anchored.map(x => x.a), lowest, highest, axisSettings.coordType)
    const laneByIndex = new Map(anchored.map((x, k) => [x.i, lanes[k]!]))
    primitives.forEach((prim, i) => drawPrimitive(sink, prim, laneByIndex.get(i) ?? 0))
    annotationOverlayIds.current = created
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesKey, dark, axisSettings.coordType])

  // Param edits or derivatives update: re-run calc in place; no canvas rebuild.
  useEffect(() => {
    const chart = chartRef.current
    if (chart === null) return
    chart.setStyles(ohlcTooltipAvoidTable(settings['REVPOINT']?.visible ?? false, chart.getSize('candle_pane', 'main' as never)?.width ?? 0))
    for (const def of EDITABLE) {
      if (def.name === 'LARGE_WALLS') continue
      const s = settings[def.name]!
      const ext = DERIV_HISTORY_INDICATORS.has(def.name) ? derivatives?.history
        : def.name === 'MTF_SR' || def.name === 'DUAL_VIEW_HTF' ? { sourceTimeframe: data.timeframe, sourceTimeframeSeconds: mtfSourceTimeframeSeconds(data.timeframe) }
        : def.name === 'AICOIN_KPATTERN' ? kpThemeExt(dark, settings) : undefined
      if (def.name === 'AICOIN_TD') { syncAicoinTd(chart, s, dark); continue }
      if (def.pane !== undefined) {
        const exists = chart.getIndicatorByPaneId(def.pane, def.name) != null
        if (!s.visible) {
          if (exists) chart.removeIndicator(def.pane, def.name)
          if (def.name === 'RSI_GRID') {
            chart.removeIndicator('pane_rsi_cum', 'RSI_GRID_CUM')
            chart.removeIndicator('candle_pane', 'RSI_GRID_MARKS')
          }
        } else if (!exists) {
          chart.createIndicator({ name: def.name, calcParams: s.params, extendData: ext }, false, { id: def.pane, height: PANE_HEIGHT })
          if (def.name === 'RSI_GRID') {
            chart.createIndicator({ name: 'RSI_GRID_CUM', calcParams: s.params }, false, { id: 'pane_rsi_cum', height: PANE_HEIGHT })
            chart.createIndicator({ name: 'RSI_GRID_MARKS', calcParams: s.params }, true, { id: 'candle_pane' })
          }
        } else {
          chart.overrideIndicator({ name: def.name, calcParams: s.params, extendData: ext }, def.pane)
          if (def.name === 'RSI_GRID') {
            chart.overrideIndicator({ name: 'RSI_GRID_CUM', calcParams: s.params }, 'pane_rsi_cum')
            chart.overrideIndicator({ name: 'RSI_GRID_MARKS', calcParams: s.params }, 'candle_pane')
          }
        }
        continue
      }
      chart.overrideIndicator({ name: def.name, calcParams: s.params, visible: s.visible, extendData: ext }, 'candle_pane')
    }
  }, [settings, derivatives, data.timeframe, dark])

  // CoinGlass 大单墙: horizontal lines, toggled via 指标参数 → 大单墙.
  useEffect(() => {
    const chart = chartRef.current
    if (chart === null) return
    for (const id of wallOverlayIds.current) {
      try { chart.removeOverlay({ id }) } catch { /* already gone */ }
    }
    wallOverlayIds.current = []
    if (!(settings['LARGE_WALLS']?.visible) || !largeWalls?.walls?.length) return
    const minWan = settings['LARGE_WALLS']?.params?.[0] ?? 100
    const maxDistPct = (settings['LARGE_WALLS']?.params?.[1] ?? 20) / 100
    const sideLimit = settings['LARGE_WALLS']?.params?.[2] ?? 8
    const minUsd = minWan * 10_000

    const last = data.candles[data.candles.length - 1]
    const curP = last?.close

    let walls = largeWalls.walls.filter(w => w.currentUsd >= minUsd)
    if (typeof curP === 'number' && curP > 0) {
      walls = walls.filter(w => Math.abs(w.price - curP) / curP <= maxDistPct)
    }

    const buys = walls.filter(w => w.side === 'buy').sort((a, b) => b.currentUsd - a.currentUsd).slice(0, sideLimit)
    const sells = walls.filter(w => w.side === 'sell').sort((a, b) => b.currentUsd - a.currentUsd).slice(0, sideLimit)
    const finalWalls = [...sells, ...buys]

    const fmt = (n: number): string => {
      const abs = Math.abs(n)
      if (abs >= 1e8) return `${(abs / 1e8).toFixed(2)}亿`
      if (abs >= 1e4) return `${(abs / 1e4).toFixed(1)}万`
      return `${abs.toFixed(0)}`
    }

    const lowest = Math.min(...data.candles.map(c => c.low))
    const highest = Math.max(...data.candles.map(c => c.high))
    const lanes = assignLabelLanes(finalWalls.map(w => w.price), lowest, highest, axisSettings.coordType)
    for (let i = 0; i < finalWalls.length; i++) {
      const w = finalWalls[i]!
      const color = w.side === 'buy' ? '#3ddc97' : '#f47067'
      const distStr = typeof curP === 'number' && curP > 0
        ? ` (${w.price >= curP ? '+' : ''}${(((w.price - curP) / curP) * 100).toFixed(1)}%)`
        : ''
      const label = `${w.exchange} ${w.side === 'buy' ? '买' : '卖'} $${fmt(w.currentUsd)}${distStr}`
      const id = chart.createOverlay({
        name: 'tm_hline',
        lock: true,
        points: [{ value: w.price }],
        extendData: { color, dashed: true, label, lane: lanes[i] ?? 0 },
      })
      if (typeof id === 'string' && id) wallOverlayIds.current.push(id)
    }
  }, [settings, largeWalls, seriesKey, data.candles.length])

  // Live tail: push the newest bar into the existing plot. klinecharts updates
  // the last bar in place, or appends when the timestamp has moved on, so the
  // same call covers "the current candle ticked" and "a new candle opened".
  // Chip panes are mounted/unmounted incrementally on the live canvas, so a
  // toggle keeps zoom and scroll (no dispose/init).
  useEffect(() => {
    const chart = chartRef.current
    const last = data.candles[data.candles.length - 1]
    if (chart === null || last === undefined) return
    chart.updateData(toKLine(last))
    const plan = planChipSync(active, mountedChips.current, id => {
      const def = CHIP_DEFS.find(d => d.id === id)
      if (!def?.indicator) return false
      if (def.indicator.builtIn === true) return def.indicator.name !== 'RSI_GRID'
      return hasSeries(data, def.indicator.figures)
    })
    for (const id of plan.remove) {
      const def = CHIP_DEFS.find(d => d.id === id)
      const paneId = mountedChips.current.get(id)
      mountedChips.current.delete(id)
      if (!def?.indicator || paneId === undefined) continue
      try { chart.removeIndicator(paneId, def.indicator.name) } catch { /* already gone */ }
    }
    for (const id of plan.add) {
      const def = CHIP_DEFS.find(d => d.id === id)!
      const ind = def.indicator!
      if (ind.builtIn === true) {
        const paneId = `pane_${def.id}`
        chart.createIndicator(ind.name, false, { id: paneId, height: PANE_HEIGHT })
        mountedChips.current.set(id, paneId)
        continue
      }
      const create = { name: ind.name, extendData: seriesRows(data, ind.figures) }
      const paneId = ind.overlay === true ? 'candle_pane' : `pane_${id}`
      chart.createIndicator(create, ind.overlay === true, { id: paneId, height: PANE_HEIGHT })
      mountedChips.current.set(id, paneId)
    }
    for (const [id, paneId] of mountedChips.current) {
      if (plan.add.includes(id)) continue
      const def = CHIP_DEFS.find(d => d.id === id)
      if (!def?.indicator || def.indicator.builtIn === true || !hasSeries(data, def.indicator.figures)) continue
      chart.overrideIndicator({ name: def.indicator.name, extendData: seriesRows(data, def.indicator.figures) }, paneId)
    }
  }, [data, active, seriesKey, dark])

  // Indicator alertconditions (VB + NW + Dual View HTF + AiCoin K线形态): fire once per id; first eval seeds.
  const vbSeen = useRef<Set<string> | null>(null)
  const [vbToasts, setVbToasts] = useState<{ id: string; text: string }[]>([])
  useEffect(() => {
    const fired: { id: string; text: string }[] = []
    const vb = settings['VB_PRO_READ']
    if (vb?.visible) fired.push(...vbAlertEvents(data.candles, vb.params))
    const nw = settings['NW_TREND']
    if (nw?.visible) fired.push(...nwAlertEvents(data.candles, nw.params))
    const dv = settings['DUAL_VIEW_HTF']
    if (dv?.visible) {
      const rows = data.candles.map(c => ({ ...c, timestamp: Date.parse(c.time) }))
      fired.push(...dvAlertEvents(rows, dv.params, data.timeframe))
    }
    const kp = settings['AICOIN_KPATTERN']
    if (kp?.visible) fired.push(...kpAlertEvents(data.candles, kp.params))
    const td = settings['AICOIN_TD']
    if (td?.visible) fired.push(...tdAlertEvents(data.candles, td.params))
    if (fired.length === 0 && !(vb?.visible || dv?.visible || nw?.visible || kp?.visible || td?.visible)) { vbSeen.current = null; return }
    if (vbSeen.current === null) { vbSeen.current = new Set(fired.map(f => f.id)); return }
    const fresh = fired.filter(f => !vbSeen.current!.has(f.id))
    if (fresh.length === 0) return
    for (const f of fresh) vbSeen.current.add(f.id)
    setVbToasts(t => [...t, ...fresh].slice(-4))
    for (const f of fresh) setTimeout(() => setVbToasts(t => t.filter(x => x.id !== f.id)), 15000)
  }, [data, settings])

  useEffect(() => {
    const chart = chartRef.current
    if (chart === null) return
    chart.setStyles({ yAxis: { type: toYAxisType(axisSettings.coordType) } })
    chart.setPaneOptions({
      id: 'candle_pane',
      gap: axisSettings.autoScale.candle ? { top: 0.08, bottom: 0.05 } : { top: 0.2, bottom: 0.1 },
    })
    if (axisSettings.autoScale.candle) {
      if (setCandleYAxisAutoCalc(chart, true)) adjustChartViewport(chart)
    } else {
      setCandleYAxisAutoCalc(chart, false)
    }
  }, [axisSettings])

  useEffect(() => {
    const container = el.current
    if (!container) return

    let isPointerDown = false
    let startX = 0
    let startY = 0
    let isVerticalUnlocked = false

    const onPointerDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      isPointerDown = true
      startX = e.clientX
      startY = e.clientY
      isVerticalUnlocked = false
    }

    const onPointerMove = (e: MouseEvent) => {
      if (!isPointerDown) return
      const dy = e.clientY - startY
      if (!isVerticalUnlocked && Math.abs(dy) >= 3) {
        const chart = chartRef.current
        if (getCandleYAxisAutoCalc(chart) === true) {
          isVerticalUnlocked = true
          setCandleYAxisAutoCalc(chart, false)
          const current = getAxisSettings()
          if (current.autoScale.candle) {
            setAxisSettings({
              ...current,
              autoScale: { ...current.autoScale, candle: false },
            })
          }
        }
      }
    }

    const onPointerUp = () => {
      if (isPointerDown) {
        isPointerDown = false
        const chart = chartRef.current
        if (getCandleYAxisAutoCalc(chart) === false) {
          const current = getAxisSettings()
          if (current.autoScale.candle) {
            setAxisSettings({
              ...current,
              autoScale: { ...current.autoScale, candle: false },
            })
          }
        }
      }
    }

    const onDoubleClick = () => {
      const chart = chartRef.current
      if (!chart) return
      resetCandleYAxisAuto(chart)
      const current = getAxisSettings()
      if (!current.autoScale.candle) {
        setAxisSettings({
          ...current,
          autoScale: { ...current.autoScale, candle: true },
        })
      }
    }

    const onWheel = (e: WheelEvent) => {
      const chart = chartRef.current
      if (!chart) return
      const rect = container.getBoundingClientRect()
      const isOverYAxis = e.clientX >= rect.right - 80 && e.clientY <= rect.bottom - 20
      if (isOverYAxis) {
        e.preventDefault()
        e.stopPropagation()
        const yAxis = getCandleYAxis(chart)
        if (!yAxis || typeof yAxis.getRange !== 'function' || typeof yAxis.setRange !== 'function') return
        try {
        const range = yAxis.getRange()
        if (!range || range.range <= 0) return
        const zoomFactor = e.deltaY > 0 ? 1.15 : 0.85
        const newRange = range.range * zoomFactor
        const relY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
        const currentPriceAtCursor = typeof yAxis.convertFromPixel === 'function'
          ? yAxis.convertFromPixel(e.clientY - rect.top)
          : range.from + (1 - relY) * range.range
        const centerRatio = Number.isFinite(currentPriceAtCursor)
          ? (currentPriceAtCursor - range.from) / range.range
          : 0.5
        const newFrom = currentPriceAtCursor - centerRatio * newRange
        const newTo = newFrom + newRange
        const realFrom = typeof yAxis.convertToRealValue === 'function' ? yAxis.convertToRealValue(newFrom) : newFrom
        const realTo = typeof yAxis.convertToRealValue === 'function' ? yAxis.convertToRealValue(newTo) : newTo
        yAxis.setRange({
          from: newFrom,
          to: newTo,
          range: newRange,
          realFrom,
          realTo,
          realRange: realTo - realFrom,
        })
        adjustChartViewport(chart)
        } catch { return /* internal axis API changed: Y-wheel zoom degrades to a no-op */ }
        const current = getAxisSettings()
        if (current.autoScale.candle) {
          setAxisSettings({
            ...current,
            autoScale: { ...current.autoScale, candle: false },
          })
        }
      }
    }

    container.addEventListener('mousedown', onPointerDown)
    window.addEventListener('mousemove', onPointerMove)
    window.addEventListener('mouseup', onPointerUp)
    container.addEventListener('dblclick', onDoubleClick)
    container.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      container.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('mousemove', onPointerMove)
      window.removeEventListener('mouseup', onPointerUp)
      container.removeEventListener('dblclick', onDoubleClick)
      container.removeEventListener('wheel', onWheel)
    }
  }, [])

  // In fill mode the plot is sized by the flex parent and the ResizeObserver
  // above keeps klinecharts in step; `minHeight` is the floor below which a
  // candlestick chart stops being a chart. Indicator panes then divide the
  // available height rather than extending the card downward.
  return (
    <div style={{ position: 'relative', width: '100%', ...(fill ? { flex: '1 1 auto', minHeight: 240 } : { height: baseHeight + paneCount * PANE_HEIGHT }) }}>
      <div ref={el} style={{ width: '100%', height: '100%' }} />
      {vbToasts.length > 0 && (
        <div role="status" aria-label="指标提醒" style={{ position: 'absolute', right: 70, top: 8, zIndex: 5, display: 'flex', flexDirection: 'column', gap: 4, pointerEvents: 'auto' }}>
          {vbToasts.map(t => (
            <div key={t.id} onClick={() => setVbToasts(x => x.filter(y => y.id !== t.id))} title="点击关闭"
              style={{ background: 'rgba(255,167,38,0.92)', color: '#111', fontSize: 12, padding: '4px 8px', borderRadius: 4, cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }}>
              🔔 {t.text}
            </div>
          ))}
        </div>
      )}
      {!axisSettings.autoScale.candle && (
        <button
          type="button"
          onClick={() => {
            const chart = chartRef.current
            resetCandleYAxisAuto(chart)
            setAxisSettings({ ...axisSettings, autoScale: { ...axisSettings.autoScale, candle: true } })
          }}
          title="双击画布或点击此处恢复K线自动坐标"
          style={{
            position: 'absolute',
            right: 68,
            bottom: 8,
            zIndex: 10,
            padding: '2px 8px',
            fontSize: 11,
            fontWeight: 600,
            color: '#38bdf8',
            background: 'rgba(18, 18, 20, 0.85)',
            border: '1px solid rgba(56, 189, 248, 0.5)',
            borderRadius: 4,
            cursor: 'pointer',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
          }}
        >
          <span>↺ 自动</span>
        </button>
      )}
    </div>
  )
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
function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={(e) => { e.stopPropagation(); onChange(!checked) }}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        background: checked ? '#ffffff' : '#27272a',
        border: '1px solid #3f3f46',
        position: 'relative',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 0.15s ease',
        outline: 'none',
      }}
    >
      <span
        style={{
          display: 'block',
          width: 14,
          height: 14,
          borderRadius: 7,
          background: checked ? '#09090b' : '#71717a',
          position: 'absolute',
          top: 2,
          left: checked ? 18 : 2,
          transition: 'left 0.15s ease',
        }}
      />
    </button>
  )
}

function AxisMenu({
  settings,
  palette,
  onChange,
  onClose,
}: {
  settings: AxisSettings
  palette: Palette
  onChange: (next: AxisSettings) => void
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const itemStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '7px 14px',
    cursor: 'pointer',
    fontSize: 13,
    color: '#e4e4e7',
    userSelect: 'none',
  }

  const headerStyle: CSSProperties = {
    fontSize: 12,
    color: '#a1a1aa',
    padding: '6px 14px 4px',
    userSelect: 'none',
  }

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        top: 28,
        right: 0,
        zIndex: 100,
        width: 160,
        background: '#121214',
        border: `1px solid ${palette.line}`,
        borderRadius: 8,
        boxShadow: '0 10px 30px rgba(0,0,0,0.7)',
        padding: '6px 0',
        fontFamily: FONT_FAMILY,
      }}
    >
      <div style={headerStyle}>坐标类型</div>
      <div
        style={itemStyle}
        onClick={() => onChange({ ...settings, coordType: 'normal' })}
      >
        <span>常规</span>
        {settings.coordType === 'normal' ? <span style={{ color: '#ffffff', fontWeight: 600 }}>✓</span> : null}
      </div>
      <div
        style={itemStyle}
        onClick={() => onChange({ ...settings, coordType: 'percentage' })}
      >
        <span>百分比</span>
        {settings.coordType === 'percentage' ? <span style={{ color: '#ffffff', fontWeight: 600 }}>✓</span> : null}
      </div>
      <div
        style={itemStyle}
        onClick={() => onChange({ ...settings, coordType: 'log' })}
      >
        <span>对数</span>
        {settings.coordType === 'log' ? <span style={{ color: '#ffffff', fontWeight: 600 }}>✓</span> : null}
      </div>

      <div style={{ height: 1, background: palette.line, margin: '6px 0' }} />

      <div style={headerStyle}>自动坐标</div>
      <div style={itemStyle}>
        <span>K线图</span>
        <Switch
          checked={settings.autoScale.candle}
          onChange={(v) => onChange({ ...settings, autoScale: { ...settings.autoScale, candle: v } })}
        />
      </div>
      <div style={itemStyle}>
        <span>RSI</span>
        <Switch
          checked={settings.autoScale.rsi}
          onChange={(v) => onChange({ ...settings, autoScale: { ...settings.autoScale, rsi: v } })}
        />
      </div>
      <div style={itemStyle}>
        <span>Acc. L/S</span>
        <Switch
          checked={settings.autoScale.accLs}
          onChange={(v) => onChange({ ...settings, autoScale: { ...settings.autoScale, accLs: v } })}
        />
      </div>
      <div style={itemStyle}>
        <span>MACD</span>
        <Switch
          checked={settings.autoScale.macd}
          onChange={(v) => onChange({ ...settings, autoScale: { ...settings.autoScale, macd: v } })}
        />
      </div>
    </div>
  )
}

/**
 * One row per editable indicator: show/hide + its params. Applies on blur or
 * Enter (not per keystroke, so typing "100" never computes WMA(1) and WMA(10)
 * on the way). Shared by every chart on the page and kept across restarts.
 */
const CATEGORIES: { id: string; label: string; names?: string[] }[] = [
  { id: 'all', label: '全部' },
  { id: 'trend', label: '趋势与通道', names: ['WMA', 'SUPERTREND', 'EVASIVE_ST', 'NW_TREND', 'VB_PRO_READ'] },
  { id: 'pattern', label: '形态与结构', names: ['DUAL_VIEW_HTF', 'AICOIN_KPATTERN', 'OB_BB', 'MTF_SR'] },
  { id: 'oscillator', label: '震荡与网格', names: ['RSI_GRID', 'AICOIN_TD', 'REVPOINT', 'ENTRY_SIGNAL'] },
  { id: 'deriv', label: '主力与衍生品', names: ['OI_POSTURE', 'LSR_RATIO', 'LARGE_WALLS'] },
]

const HTF_BULLISH_INDICES = [21, 23, 24, 27, 29, 30, 32, 34, 35, 37]
const HTF_BEARISH_INDICES = [20, 22, 25, 26, 28, 31, 33, 36, 38]

/**
 * Modern grouped, collapsible indicator param editor with dual-direction
 * symmetry, quick pattern batch toggles, and compact card layout.
 */
function ParamEditor({ settings, palette, onClose }: {
  settings: IndicatorSettings
  palette: Palette
  onClose: () => void
}): JSX.Element {
  const [activeCategory, setActiveCategory] = useState<string>('all')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const input: CSSProperties = {
    width: 56, background: 'transparent', color: 'inherit', fontSize: 11,
    border: `1px solid ${palette.line}`, borderRadius: 3, padding: '1px 4px',
  }

  const commit = (name: string, i: number, raw: string, el: HTMLInputElement): void => {
    const s = settings[name]!
    const params = [...s.params]
    params[i] = Number(raw)
    const next = sanitizeSettings({ ...settings, [name]: { ...s, params } })
    el.value = String(next[name]!.params[i])
    if (next[name]!.params[i] !== s.params[i]) setSettings(next)
  }

  const toggleExpand = (name: string): void => {
    setExpanded(prev => ({ ...prev, [name]: !(prev[name] ?? settings[name]?.visible ?? false) }))
  }

  const setAllExpanded = (val: boolean): void => {
    const next: Record<string, boolean> = {}
    for (const def of EDITABLE) next[def.name] = val
    setExpanded(next)
  }

  const cat = CATEGORIES.find(c => c.id === activeCategory)
  const visibleDefs = EDITABLE.filter(d => !cat?.names || cat.names.includes(d.name))

  return (
    <div
      role="group"
      aria-label="指标参数"
      style={{
        display: 'flex', flexDirection: 'column', gap: 8, padding: 10, marginBottom: 8, fontSize: 11,
        border: `1px solid ${palette.line}`, borderRadius: 6, flex: '0 0 auto',
        maxHeight: '420px', overflowY: 'auto', background: 'rgba(15, 20, 25, 0.4)',
      }}
    >
      {/* Category Tabs */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, borderBottom: `1px solid ${palette.line}`, paddingBottom: 6 }}>
        {CATEGORIES.map(c => {
          const active = c.id === activeCategory
          return (
            <button
              key={c.id}
              onClick={() => setActiveCategory(c.id)}
              style={{
                background: active ? 'rgba(83, 155, 245, 0.15)' : 'transparent',
                color: active ? '#539bf5' : palette.faint,
                border: `1px solid ${active ? '#539bf5' : palette.line}`,
                borderRadius: 4, padding: '2px 8px', fontSize: 11, cursor: 'pointer',
                fontWeight: active ? 'bold' : 'normal',
              }}
            >
              {c.label}
            </button>
          )
        })}
      </div>

      {/* Indicator Cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {visibleDefs.map(def => {
          const s = settings[def.name]!
          const isExpanded = expanded[def.name] ?? s.visible
          const hasParams = def.params.length > 0

          return (
            <div
              key={def.name}
              style={{
                display: 'flex', flexDirection: 'column', gap: 6,
                padding: '6px 8px', borderRadius: 4,
                border: `1px solid ${s.visible ? 'rgba(83, 155, 245, 0.25)' : palette.line}`,
                background: s.visible ? 'rgba(83, 155, 245, 0.03)' : 'transparent',
              }}
            >
              {/* Header row */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontWeight: s.visible ? 'bold' : 'normal' }}>
                  <input
                    type="checkbox"
                    checked={s.visible}
                    onChange={e => {
                      const willBeVisible = e.target.checked
                      setSettings({ ...settings, [def.name]: { ...s, visible: willBeVisible } })
                      if (willBeVisible && expanded[def.name] === undefined) {
                        setExpanded(prev => ({ ...prev, [def.name]: true }))
                      }
                    }}
                  />
                  <span>{def.title}</span>
                  <span style={{
                    fontSize: 9, padding: '0 4px', borderRadius: 3,
                    border: `1px solid ${s.visible ? 'rgba(61,220,151,0.4)' : palette.line}`,
                    color: s.visible ? '#3ddc97' : palette.faint,
                  }}>
                    {s.visible ? '已开启' : '未开启'}
                  </span>
                </label>

                {hasParams ? (
                  <button
                    onClick={() => toggleExpand(def.name)}
                    style={{
                      background: 'transparent', color: palette.faint, border: 'none',
                      fontSize: 10, cursor: 'pointer', padding: '1px 6px',
                    }}
                  >
                    ⚙ 参数 {isExpanded ? '▲ 收起' : '▼ 展开'}
                  </button>
                ) : null}
              </div>

              {/* Params sub-panel */}
              {isExpanded && hasParams ? (
                <div style={{
                  padding: '6px 8px', marginTop: 2,
                  borderLeft: `2px solid ${s.visible ? '#539bf5' : palette.line}`,
                  background: 'rgba(0, 0, 0, 0.15)', borderRadius: '0 4px 4px 0',
                }}>
                  {def.name === 'DUAL_VIEW_HTF' ? (
                    /* Custom Layout for Dual View HTF Patterns */
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {/* General settings (0..19) */}
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                        {def.params.slice(0, 20).map((spec, idx) => renderControl(def.name, spec, idx, s.params[idx]!, s.params, commit, setSettings, settings, palette, input))}
                      </div>

                      {/* Pattern filtering box (20..38) */}
                      <div style={{
                        display: 'flex', flexDirection: 'column', gap: 6, padding: 8,
                        background: 'rgba(255, 255, 255, 0.02)', borderRadius: 4,
                        border: `1px solid ${palette.line}`,
                      }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                          <span style={{ fontWeight: 'bold', color: palette.text }}>
                            K线形态多空筛选 ({HTF_BULLISH_INDICES.filter(i => s.params[i] === 1).length + HTF_BEARISH_INDICES.filter(i => s.params[i] === 1).length}/19)
                          </span>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              onClick={() => {
                                const nextP = [...s.params]
                                for (const i of HTF_BULLISH_INDICES) nextP[i] = 1
                                setSettings(sanitizeSettings({ ...settings, [def.name]: { ...s, params: nextP } }))
                              }}
                              style={{ background: 'rgba(61,220,151,0.1)', color: '#3ddc97', border: '1px solid rgba(61,220,151,0.3)', borderRadius: 3, fontSize: 10, cursor: 'pointer', padding: '1px 6px' }}
                            >🟢 全选看涨 (10)</button>
                            <button
                              onClick={() => {
                                const nextP = [...s.params]
                                for (const i of HTF_BEARISH_INDICES) nextP[i] = 1
                                setSettings(sanitizeSettings({ ...settings, [def.name]: { ...s, params: nextP } }))
                              }}
                              style={{ background: 'rgba(244,112,103,0.1)', color: '#f47067', border: '1px solid rgba(244,112,103,0.3)', borderRadius: 3, fontSize: 10, cursor: 'pointer', padding: '1px 6px' }}
                            >🔴 全选看跌 (9)</button>
                            <button
                              onClick={() => {
                                const nextP = [...s.params]
                                for (let i = 20; i <= 38; i++) nextP[i] = 1
                                setSettings(sanitizeSettings({ ...settings, [def.name]: { ...s, params: nextP } }))
                              }}
                              style={{ background: 'transparent', color: palette.faint, border: `1px solid ${palette.line}`, borderRadius: 3, fontSize: 10, cursor: 'pointer', padding: '1px 6px' }}
                            >全部开启</button>
                            <button
                              onClick={() => {
                                const nextP = [...s.params]
                                for (let i = 20; i <= 38; i++) nextP[i] = 0
                                setSettings(sanitizeSettings({ ...settings, [def.name]: { ...s, params: nextP } }))
                              }}
                              style={{ background: 'transparent', color: palette.faint, border: `1px solid ${palette.line}`, borderRadius: 3, fontSize: 10, cursor: 'pointer', padding: '1px 6px' }}
                            >全部关闭</button>
                          </div>
                        </div>

                        {/* Two columns: Bullish / Bearish */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 8 }}>
                          {/* Bullish column */}
                          <div style={{
                            display: 'flex', flexDirection: 'column', gap: 4, padding: 6,
                            background: 'rgba(61, 220, 151, 0.04)', borderRadius: 4,
                            border: '1px solid rgba(61, 220, 151, 0.15)',
                          }}>
                            <span style={{ color: '#3ddc97', fontWeight: 'bold', fontSize: 10 }}>🟢 看涨形态 (10项)</span>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {HTF_BULLISH_INDICES.map(idx => renderControl(def.name, def.params[idx]!, idx, s.params[idx]!, s.params, commit, setSettings, settings, palette, input))}
                            </div>
                          </div>

                          {/* Bearish column */}
                          <div style={{
                            display: 'flex', flexDirection: 'column', gap: 4, padding: 6,
                            background: 'rgba(244, 112, 103, 0.04)', borderRadius: 4,
                            border: '1px solid rgba(244, 112, 103, 0.15)',
                          }}>
                            <span style={{ color: '#f47067', fontWeight: 'bold', fontSize: 10 }}>🔴 看跌形态 (9项)</span>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {HTF_BEARISH_INDICES.map(idx => renderControl(def.name, def.params[idx]!, idx, s.params[idx]!, s.params, commit, setSettings, settings, palette, input))}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Display & style settings (39..end) */}
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                        {def.params.slice(39).map((spec, relIdx) => {
                          const idx = 39 + relIdx
                          return renderControl(def.name, spec, idx, s.params[idx]!, s.params, commit, setSettings, settings, palette, input)
                        })}
                      </div>
                    </div>
                  ) : def.name === 'AICOIN_KPATTERN' ? (
                    /* AiCoin K线形态: display options, bullish / bearish groups (show + colour), alertconditions */
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                        {[KP_THEME, KP_MODE, KP_FORMING, KP_LAST, KP_FONT, ...(s.params[KP_THEME] === 1 ? [] : [KP_BG_ON, KP_BG_COLOR])]
                          .map(idx => renderControl(def.name, def.params[idx]!, idx, s.params[idx]!, s.params, commit, setSettings, settings, palette, input))}
                      </div>
                      {([['看涨 · 标在低点下方', KP_BULL_INDICES, palette.up], ['看跌 · 标在高点上方', KP_BEAR_INDICES, palette.down]] as const).map(([label, group, tone]) => (
                        <div key={label} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: 6, border: `1px solid ${palette.line}`, borderRadius: 4 }}>
                          <span style={{ color: tone, fontWeight: 'bold' }}>{label} ({group.filter(n => s.params[KP_SHOW + n] === 1).length}/{group.length})</span>
                          {([['全开', 1], ['全关', 0]] as const).map(([text, v]) => (
                            <button key={text} style={{ background: 'transparent', color: palette.faint, border: `1px solid ${palette.line}`, borderRadius: 3, fontSize: 10, cursor: 'pointer', padding: '1px 6px' }} onClick={() => {
                              const next = [...s.params]
                              for (const n of group) next[KP_SHOW + n] = v
                              setSettings(sanitizeSettings({ ...settings, [def.name]: { ...s, params: next } }))
                            }}>{text}</button>
                          ))}
                          {group.map(n => (
                            <span key={n} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                              {renderControl(def.name, def.params[KP_SHOW + n]!, KP_SHOW + n, s.params[KP_SHOW + n]!, s.params, commit, setSettings, settings, palette, input)}
                              {s.params[KP_THEME] === 1 ? null : renderControl(def.name, { ...def.params[KP_COLOR + n]!, label: '' }, KP_COLOR + n, s.params[KP_COLOR + n]!, s.params, commit, setSettings, settings, palette, input)}
                            </span>
                          ))}
                        </div>
                      ))}
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                        {KP_ALERTS.map((_, k) => renderControl(def.name, def.params[KP_ALERT + k]!, KP_ALERT + k, s.params[KP_ALERT + k]!, s.params, commit, setSettings, settings, palette, input))}
                      </div>
                    </div>
                  ) : def.name === 'RSI_GRID' ? (
                    /* Custom Layout for Dual-Direction RSI Grid */
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                        {def.params.map((spec, i) => renderControl(def.name, spec, i, s.params[i]!, s.params, commit, setSettings, settings, palette, input))}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 2, fontSize: 10 }}>
                        <span style={{ color: '#3ddc97', background: 'rgba(61,220,151,0.08)', padding: '2px 6px', borderRadius: 3, border: '1px solid rgba(61,220,151,0.2)' }}>
                          🟢 多头网格: RSI &lt; {s.params[1] ?? 30} 累计超卖 &gt; {s.params[3] ?? 10} 进多 | ≥ {s.params[2] ?? 60} 止盈
                        </span>
                        <span style={{ color: '#f47067', background: 'rgba(244,112,103,0.08)', padding: '2px 6px', borderRadius: 3, border: '1px solid rgba(244,112,103,0.2)' }}>
                          🔴 空头网格: RSI &gt; {100 - (s.params[2] ?? 60)} 累计超买 &gt; {s.params[3] ?? 10} 进空 | ≤ {100 - (s.params[1] ?? 30)} 止盈
                        </span>
                      </div>
                    </div>
                  ) : (
                    /* Standard Indicator Params */
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                      {def.params.map((spec, i) => renderControl(def.name, spec, i, s.params[i]!, s.params, commit, setSettings, settings, palette, input))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {/* Footer action bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: `1px solid ${palette.line}`, paddingTop: 6, marginTop: 4 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => setAllExpanded(true)}
            style={{ background: 'transparent', color: palette.faint, border: `1px solid ${palette.line}`, borderRadius: 4, fontSize: 11, cursor: 'pointer', padding: '2px 8px' }}
          >全部展开</button>
          <button
            onClick={() => setAllExpanded(false)}
            style={{ background: 'transparent', color: palette.faint, border: `1px solid ${palette.line}`, borderRadius: 4, fontSize: 11, cursor: 'pointer', padding: '2px 8px' }}
          >全部折叠</button>
          <button
            onClick={() => setSettings(sanitizeSettings(null))}
            style={{ background: 'transparent', color: palette.faint, border: `1px solid ${palette.line}`, borderRadius: 4, fontSize: 11, cursor: 'pointer', padding: '2px 8px' }}
          >恢复默认</button>
        </div>
        <button
          onClick={onClose}
          style={{ background: 'rgba(83, 155, 245, 0.1)', color: '#539bf5', border: '1px solid rgba(83, 155, 245, 0.3)', borderRadius: 4, fontSize: 11, cursor: 'pointer', padding: '2px 12px', fontWeight: 'bold' }}
        >完成并收起</button>
      </div>
    </div>
  )
}

function renderControl(
  defName: string,
  spec: ParamSpec,
  i: number,
  val: number,
  params: number[],
  commit: (name: string, i: number, raw: string, el: HTMLInputElement) => void,
  setSettings: (s: IndicatorSettings) => void,
  settings: IndicatorSettings,
  palette: Palette,
  input: CSSProperties
): JSX.Element {
  const set = (v: number): void => {
    const next = [...params]; next[i] = v
    setSettings(sanitizeSettings({ ...settings, [defName]: { ...settings[defName]!, params: next } }))
  }
  const lab = { display: 'flex', alignItems: 'center', gap: 4, color: palette.faint } as const
  if (spec.kind === 'select') return (
    <label key={`${defName}-${i}`} style={lab}>{spec.label}
      <select value={val} onChange={e => set(Number(e.target.value))} style={{ ...input, width: 'auto' }}>
        {(spec.options ?? []).map((o, k) => <option key={k} value={k}>{o}</option>)}
      </select>
    </label>)
  if (spec.kind === 'bool') return (
    <label key={`${defName}-${i}`} style={lab}>
      <input type="checkbox" checked={val === 1} onChange={e => set(e.target.checked ? 1 : 0)} />{spec.label}
    </label>)
  if (spec.kind === 'color') return (
    <label key={`${defName}-${i}`} style={lab}>{spec.label}
      <input type="color" value={intToHex(val).toLowerCase()} onChange={e => set(parseInt(e.target.value.slice(1), 16))}
        style={{ width: 28, height: 18, padding: 0, border: `1px solid ${palette.line}`, background: 'transparent' }} />
    </label>)
  return (
    <label key={`${defName}-${i}-${val}`} style={lab}>
      {spec.label}
      <input
        type="number"
        defaultValue={val}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        style={input}
        onBlur={e => commit(defName, i, e.target.value, e.target)}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
      />
    </label>
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
  return ['vol']
}

export function ChartBody({ payload, chartHeight = CHART_HEIGHT, shell = SHELL, fill = false, prose = true, derivatives, largeWalls, onCrosshairHover, history }: {
  payload: ChartPayload
  history?: ChartHistory | undefined
  chartHeight?: number
  shell?: CSSProperties
  fill?: boolean
  prose?: boolean
  derivatives?: PanelDerivatives | null
  largeWalls?: PanelLargeOrders | null
  onCrosshairHover?: (timestamp: number | null) => void
}): JSX.Element {
  const dark = useDark()
  const [activeTf, setActiveTf] = useState(0)
  const [activeChips, setActiveChips] = useState<string[]>(getInitialActiveChips)
  const settings = useSyncExternalStore(subscribeSettings, getSettings)
  const [editing, setEditing] = useState(false)
  const axisSettings = useSyncExternalStore(subscribeAxisSettings, getAxisSettings, () => DEFAULT_AXIS_SETTINGS)
  const [showAxisMenu, setShowAxisMenu] = useState(false)
  // Left edge the rebuild key keeps while loadMore prepends history: `prepended`
  // is the first bar time the canvas itself produced, `edge` the original one.
  const historyEdge = useRef<{ prepended: string; edge: string } | null>(null)
  const historyForKline = useMemo<ChartHistory | undefined>(() => history === undefined ? undefined : {
    load: history.load,
    commit: (older) => {
      const first = older[0]?.time
      const cur = historyEdge.current
      const edge = cur?.edge ?? rawTfEdge.current
      if (first !== undefined && edge !== undefined) historyEdge.current = { prepended: first, edge }
      history.commit(older)
    },
  }, [history])
  const rawTfEdge = useRef<string | undefined>(undefined)

  const rawTf = payload.timeframes[Math.min(activeTf, payload.timeframes.length - 1)]
  const tf = useMemo(() => {
    if (!rawTf) return undefined
    return enrichChartTimeframe(rawTf)
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
  const toggle = (id: string): void => {
    if (id === 'rsi') {
      const cur = settings['RSI_GRID']!
      setSettings({ ...settings, RSI_GRID: { ...cur, visible: !cur.visible } })
      return
    }
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
  }

  const chipRow = tf.indicators === null ? [] : CHIP_DEFS.flatMap((def) => {
    const { text, state } = def.label(tf.indicators!)
    if (typeof state !== 'string' || state === '') return []
    const togglable = def.indicator !== undefined && (def.indicator.builtIn === true || hasSeries(tf, def.indicator.figures))
    return [{ id: def.id, text: `${text} · ${zhState(state)}`, togglable, on: def.id === 'rsi' ? (settings['RSI_GRID']?.visible ?? false) : activeChips.includes(def.id) }]
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
  const firstTime = tf.candles[0]?.time ?? ''
  const he = historyEdge.current
  const keyEdge = he !== null && he.prepended === firstTime ? he.edge : firstTime
  if (he !== null && he.prepended !== firstTime) historyEdge.current = null
  rawTfEdge.current = keyEdge
  const seriesKey = `${payload.provider}|${payload.symbol}|${tf.timeframe}|${keyEdge}|${annotationDigest(tf.annotations, scenarios)}`

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
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <button
              onClick={() => setShowAxisMenu(m => !m)}
              aria-expanded={showAxisMenu}
              style={{
                border: `1px solid ${showAxisMenu ? palette.text : palette.line}`,
                background: 'transparent', color: 'inherit', borderRadius: 4,
                padding: '1px 8px', fontSize: 11, cursor: 'pointer',
              }}
            >📐 坐标</button>
            {showAxisMenu ? (
              <AxisMenu
                settings={axisSettings}
                palette={palette}
                onChange={(next) => setAxisSettings(next)}
                onClose={() => setShowAxisMenu(false)}
              />
            ) : null}
          </div>
          <button
            onClick={() => setEditing(e => !e)}
            aria-expanded={editing}
            style={{
              border: `1px solid ${editing ? palette.text : palette.line}`,
              background: 'transparent', color: 'inherit', borderRadius: 4,
              padding: '1px 8px', fontSize: 11, cursor: 'pointer',
            }}
          >⚙ 指标参数</button>
        </div>
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
        axisSettings={axisSettings}
        derivatives={derivatives}
        largeWalls={largeWalls}
        onCrosshairHover={onCrosshairHover}
        history={historyForKline}
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
