/**
 * klinecharts 10.x adapters: DataLoader wiring, tooltip features/legends,
 * indicator lookup, period/symbol helpers, drawing/theme/convert helpers.
 * ChartCard and indicators should prefer these over leftover 9.x call shapes.
 */
import {
  registerStyles,
} from 'klinecharts'
import type {
  Chart,
  Coordinate,
  ConvertFilter,
  DataLoader,
  DataLoaderGetBarsParams,
  DeepPartial,
  Indicator,
  IndicatorCreate,
  IndicatorTooltipData,
  KLineData,
  OverlayMode,
  Period,
  PeriodType,
  Point,
  Styles,
  TooltipFeatureStyle,
  TooltipLegend,
} from 'klinecharts'

export type CandleLike = {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

/** groupId for user hand-draw overlays so clear/magnet can target them. */
export const USER_DRAW_GROUP = 'dsh-user-draw'

/** Left Y-axis id created by the multi-Y toggle. */
export const LEFT_Y_AXIS_ID = 'dsh-left-y'

export function toKLineData(c: CandleLike): KLineData {
  const row: KLineData = {
    timestamp: Date.parse(c.time),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }
  if (c.volume !== undefined) row.volume = c.volume
  return row
}

/** Map our timeframe strings (1m/5m/1h/1d/…) to klinecharts 10 Period. */
export function periodFromTimeframe(tf: string): Period {
  const m = /^(\d+)([smhdwM])$/.exec(tf.trim())
  if (!m) return { span: 1, type: 'minute' }
  const span = Number(m[1])
  const unit = m[2]!
  const type: PeriodType =
    unit === 's' ? 'second'
    : unit === 'm' ? 'minute'
    : unit === 'h' ? 'hour'
    : unit === 'd' ? 'day'
    : unit === 'w' ? 'week'
    : 'month'
  return { span, type }
}

/** 10.x tooltip feature (replaces 9.x icons with icon/fontFamily). */
export function tooltipFeatureIcon(id: string, code: string, position: TooltipFeatureStyle['position'] = 'right'): TooltipFeatureStyle {
  return {
    id,
    position,
    type: 'icon_font',
    content: { code, family: 'Segoe UI Symbol, Apple Symbols, sans-serif' },
    size: 12,
    color: '#8b949e',
    activeColor: '#c9d1d9',
    backgroundColor: 'transparent',
    activeBackgroundColor: 'rgba(139,148,158,0.2)',
    borderRadius: 0,
    marginLeft: 4,
    marginTop: 4,
    marginRight: 4,
    marginBottom: 4,
    paddingLeft: 2,
    paddingTop: 0,
    paddingRight: 2,
    paddingBottom: 0,
  }
}

export function emptyTooltip(): IndicatorTooltipData {
  return { name: '', calcParamsText: '', legends: [], features: [] }
}

export function tooltipOf(partial: {
  name?: string
  calcParamsText?: string
  legends?: TooltipLegend[]
  features?: TooltipFeatureStyle[]
}): IndicatorTooltipData {
  return {
    name: partial.name ?? '',
    calcParamsText: partial.calcParamsText ?? '',
    legends: partial.legends ?? [],
    features: partial.features ?? [],
  }
}

export function hasIndicator(chart: Chart, paneId: string, name: string): boolean {
  return chart.getIndicators({ paneId, name }).length > 0
}

export function removeIndicator(chart: Chart, paneId: string, name: string): boolean {
  return chart.removeIndicator({ paneId, name })
}

export function overrideIndicator(chart: Chart, override: IndicatorCreate, paneId?: string): boolean {
  return chart.overrideIndicator(paneId ? { ...override, paneId } : override)
}

/**
 * createIndicator + pane height. 10.x dropped the 3rd options arg; place via
 * indicator.paneId and setPaneOptions({ height }).
 */
export function createIndicatorInPane(
  chart: Chart,
  value: string | IndicatorCreate,
  opts: { paneId: string; isStack?: boolean; height?: number },
): string | null {
  const create: IndicatorCreate = typeof value === 'string' ? { name: value, paneId: opts.paneId } : { ...value, paneId: opts.paneId }
  const id = chart.createIndicator(create, opts.isStack === true)
  if (opts.height !== undefined && opts.paneId !== 'candle_pane') {
    try { chart.setPaneOptions({ id: opts.paneId, height: opts.height }) } catch { /* pane may already exist */ }
  }
  return id
}

export type BarSubscriber = ((bar: KLineData) => void) | null

/**
 * Build a DataLoader bound to mutable candle/history refs.
 *
 * klinecharts naming (time axis left=older, right=newer):
 * - type `forward`  → scrolled to LEFT edge  → load OLDER than first bar
 * - type `backward` → scrolled to RIGHT edge → load NEWER than last bar
 *
 * Call resetData() (or setSymbol/setPeriod) when the series identity changes;
 * push live ticks through the subscribe callback returned via `onSubscribe`.
 */
export function createCandleDataLoader(opts: {
  getCandles: () => readonly CandleLike[]
  /** Older bars strictly before `beforeMs` (ascending). Used for type=forward. */
  loadOlder?: (beforeMs: number) => Promise<readonly CandleLike[]>
  commitOlder?: (rows: readonly CandleLike[]) => void
  /** Newer bars strictly after `afterMs` (ascending). Used for type=backward. */
  loadNewer?: (afterMs: number) => Promise<readonly CandleLike[]>
  commitNewer?: (rows: readonly CandleLike[]) => void
  onSubscribe?: (cb: BarSubscriber) => void
}): DataLoader {
  let barCb: BarSubscriber = null
  const hasOlder = opts.loadOlder !== undefined
  const hasNewer = opts.loadNewer !== undefined
  return {
    getBars: ({ type, timestamp, callback }: DataLoaderGetBarsParams) => {
      if (type === 'init') {
        const rows = opts.getCandles().map(toKLineData)
        callback(rows, { forward: hasOlder, backward: hasNewer })
        return
      }
      // Scroll left (oldest edge): load bars older than the first timestamp.
      if (type === 'forward' && opts.loadOlder && timestamp != null) {
        void opts.loadOlder(timestamp).then(
          (older) => {
            const rows = older.filter(c => Date.parse(c.time) < timestamp)
            callback(rows.map(toKLineData), { forward: rows.length > 0 })
            if (rows.length > 0) opts.commitOlder?.(rows)
          },
          () => callback([], { forward: false }),
        )
        return
      }
      // Scroll right (newest edge): load bars newer than the last timestamp.
      if (type === 'backward' && opts.loadNewer && timestamp != null) {
        void opts.loadNewer(timestamp).then(
          (newer) => {
            const rows = newer.filter(c => Date.parse(c.time) > timestamp)
            callback(rows.map(toKLineData), { backward: rows.length > 0 })
            if (rows.length > 0) opts.commitNewer?.(rows)
          },
          () => callback([], { backward: false }),
        )
        return
      }
      callback([], false)
    },
    subscribeBar: ({ callback }) => {
      barCb = callback
      opts.onSubscribe?.(barCb)
    },
    unsubscribeBar: () => {
      barCb = null
      opts.onSubscribe?.(null)
    },
  }
}

/** Y-axis template name for our CoordType. */
export function yAxisNameForCoord(coord: 'normal' | 'percentage' | 'log'): string {
  if (coord === 'percentage') return 'percentage'
  if (coord === 'log') return 'logarithm'
  return 'normal'
}

/**
 * NOTE on calc return shape (10.1.0): the migration guide / website still say
 * `Record<timestamp, row>`, but the published 10.1.0 runtime + built-ins index
 * `result[dataIndex]` (arrays). Custom indicators must return D[] until the
 * library actually switches. See klinecharts src/extension/indicator/movingAverage.ts.
 */
export function assertCalcArray<T>(rows: T[]): T[] {
  return rows
}

// ── Hand-draw / magnet / clear ──────────────────────────────────────────────

export function createUserDrawing(chart: Chart, name: string, mode: OverlayMode = 'normal'): string | null {
  const id = chart.createOverlay({
    name,
    groupId: USER_DRAW_GROUP,
    mode,
    // no points → interactive click-draw
  })
  return typeof id === 'string' ? id : Array.isArray(id) ? (id[0] ?? null) : null
}

export function clearUserDrawings(chart: Chart): boolean {
  try {
    return chart.removeOverlay({ groupId: USER_DRAW_GROUP })
  } catch {
    return false
  }
}

export function setUserDrawMagnet(chart: Chart, mode: OverlayMode): boolean {
  try {
    return chart.overrideOverlay({ groupId: USER_DRAW_GROUP, mode })
  } catch {
    return false
  }
}

// ── Multi Y-axis ────────────────────────────────────────────────────────────

/** Toggle a left-side Y-axis on candle_pane. Returns whether left axis is on. */
export function toggleLeftYAxis(chart: Chart, wantOn: boolean): boolean {
  if (wantOn) {
    try {
      const existing = chart.getYAxes({ paneId: 'candle_pane', id: LEFT_Y_AXIS_ID })
      if (existing.length > 0) return true
      const id = chart.createYAxis({
        id: LEFT_Y_AXIS_ID,
        paneId: 'candle_pane',
        name: 'normal',
        position: 'left',
        scrollZoomEnabled: true,
      })
      return id != null
    } catch (e) {
      console.warn('[client-chart] createYAxis failed', e)
      return false
    }
  }
  try {
    chart.removeYAxis({ paneId: 'candle_pane', id: LEFT_Y_AXIS_ID })
  } catch { /* */ }
  return false
}

// ── Programmatic zoom ───────────────────────────────────────────────────────

export function zoomByFactor(chart: Chart, factor: number, animationDuration = 200): void {
  try {
    const range = chart.getVisibleRange()
    const mid = Math.floor((range.from + range.to) / 2)
    chart.zoomAtDataIndex(factor, mid, animationDuration)
  } catch {
    try { chart.zoomAtCoordinate(factor, undefined, animationDuration) } catch { /* */ }
  }
}

// ── Coordinate convert helpers (for marks / overlays) ───────────────────────

export function convertPointsToPixel(
  chart: Chart,
  points: Partial<Point> | Array<Partial<Point>>,
  filter?: ConvertFilter,
): Partial<Coordinate> | Array<Partial<Coordinate>> {
  return chart.convertToPixel(points, filter)
}

export function convertPixelToPoints(
  chart: Chart,
  coordinates: Array<Partial<Coordinate>>,
  filter?: ConvertFilter,
): Partial<Point> | Array<Partial<Point>> {
  return chart.convertFromPixel(coordinates, filter)
}

// ── Named themes via registerStyles ─────────────────────────────────────────

let themesRegistered = false

export function ensureChartThemes(styles: {
  dark: DeepPartial<Styles>
  light: DeepPartial<Styles>
}): void {
  if (themesRegistered) return
  registerStyles('dsh-dark', styles.dark)
  registerStyles('dsh-light', styles.light)
  themesRegistered = true
}

/** Test helper: reset the once-flag (unit tests only). */
export function __resetChartThemesForTest(): void {
  themesRegistered = false
}

export type { Indicator, IndicatorTooltipData, TooltipLegend, TooltipFeatureStyle, KLineData, Period, OverlayMode }
