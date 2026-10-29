/**
 * klinecharts 10.x IndicatorDrawParams only passes
 * { ctx, chart, indicator, bounding, xAxis, yAxis }.
 * Visible range / data list / bar space come from chart APIs.
 */

export type VisibleRange = { from: number; to: number }

export type BarSpaceLike = {
  bar: number
  halfBar: number
  gapBar: number
  halfGapBar: number
}

/** Minimal candle shape custom draws read from chart.getDataList(). */
export type DrawCandle = {
  open?: number
  high?: number
  low?: number
  close?: number
  volume?: number
  timestamp?: number
  [key: string]: unknown
}

export type ChartDrawApi = {
  getVisibleRange: () => VisibleRange
  getDataList: () => DrawCandle[]
  getBarSpace?: () => BarSpaceLike
}

export function resolveDrawContext(chart: ChartDrawApi): {
  visibleRange: VisibleRange
  kLineDataList: DrawCandle[]
  barSpace: BarSpaceLike | undefined
} {
  return {
    visibleRange: chart.getVisibleRange(),
    kLineDataList: chart.getDataList(),
    barSpace: chart.getBarSpace?.(),
  }
}

/** Build a ChartDrawApi mock for unit tests that call draw() directly. */
export function mockChart(opts: {
  visibleRange?: VisibleRange
  kLineDataList?: readonly unknown[]
  barSpace?: Partial<BarSpaceLike>
}): ChartDrawApi {
  const list = (opts.kLineDataList ?? []) as DrawCandle[]
  const api: ChartDrawApi = {
    getVisibleRange: () => opts.visibleRange ?? { from: 0, to: list.length },
    getDataList: () => list,
  }
  if (opts.barSpace) {
    const bar = opts.barSpace.bar ?? 10
    const barSpace: BarSpaceLike = {
      bar,
      halfBar: opts.barSpace.halfBar ?? bar / 2,
      gapBar: opts.barSpace.gapBar ?? Math.max(1, bar * 0.7),
      halfGapBar: opts.barSpace.halfGapBar ?? Math.max(0.5, bar * 0.35),
    }
    api.getBarSpace = () => barSpace
  }
  return api
}
