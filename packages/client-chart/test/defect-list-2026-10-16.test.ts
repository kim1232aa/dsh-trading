/**
 * Pins the fixes from the 2026-10-16 external defect review (items 1–8).
 */
import { describe, expect, it } from 'vitest'
import {
  adjustChartViewport, assignLabelLanes, enrichChartTimeframe, getCandleYAxis, getCandleYAxisAutoCalc,
  planChipSync, resetCandleYAxisAuto, setCandleYAxisAutoCalc,
} from '../src/client/ChartCard.js'
import { candlesToPayload, olderThan, timeframesForSource, withCandles } from '../src/client/market-client.js'
import { mtfSourceTimeframeSeconds } from '../src/client/indicators/mtf-sr.js'
import { nwTrendRuns } from '../src/client/indicators/nadaraya-watson.js'
import { readOhlcvRequest } from '../src/market-rpc.js'

const bar = (i: number, close = 100 + Math.sin(i / 5) * 4) => ({
  time: new Date(Date.UTC(2026, 0, 1, 0, i * 15)).toISOString(),
  open: close - 0.3, high: close + 1, low: close - 1, close, volume: 1000 + i,
})

describe('#1 chip toggles are incremental', () => {
  const all = () => true
  it('adds only new chips and removes only dropped ones', () => {
    expect(planChipSync(['macd', 'stoch'], new Map([['macd', 'pane_macd'], ['adx', 'pane_adx']]), all))
      .toEqual({ add: ['stoch'], remove: ['adx'] })
  })
  it('does nothing when the set is unchanged', () => {
    expect(planChipSync(['macd'], new Map([['macd', 'pane_macd']]), all)).toEqual({ add: [], remove: [] })
  })
  it('does not mount a chip that has no series yet', () => {
    expect(planChipSync(['macd'], new Map(), () => false)).toEqual({ add: [], remove: [] })
  })
})

describe('#2 live forming bar recomputes subplot series', () => {
  it('a tick on the last bar changes the last MACD/RSI values', () => {
    const candles = Array.from({ length: 120 }, (_, i) => bar(i))
    const p = candlesToPayload('sim', 'SIM', '15m', candles)
    const a = enrichChartTimeframe(p.timeframes[0]!)
    const ticked = [...candles.slice(0, -1), { ...candles.at(-1)!, close: candles.at(-1)!.close + 5, high: candles.at(-1)!.high + 5 }]
    const b = enrichChartTimeframe(withCandles(p, ticked).timeframes[0]!)
    expect(b.series!['macd_hist']!.at(-1)).not.toBe(a.series!['macd_hist']!.at(-1))
    expect(b.series!['rsi14']!.at(-1)).not.toBe(a.series!['rsi14']!.at(-1))
  })
})

describe('#3 timeframe buttons follow the provider', () => {
  it('uses the provider-reported list', () => {
    expect(timeframesForSource('cn', [{ id: 'cn', timeframes: ['1m', '5m', '15m', '30m', '1h', '1d', '1w'] }]))
      .toEqual(['1m', '5m', '15m', '30m', '1h', '1d', '1w'])
  })
  it('falls back to known gaps when the host did not report', () => {
    expect(timeframesForSource('cn', [])).not.toContain('2h')
    expect(timeframesForSource('okx', [])).not.toContain('8h')
    expect(timeframesForSource('okx', [])).toContain('1M')
  })
  it('shows everything for unknown / auto sources', () => {
    expect(timeframesForSource('auto', [])).toHaveLength(15)
  })
})

describe('#4 private yAxis access degrades instead of throwing', () => {
  const variants: unknown[] = [
    {},
    { getDrawPaneById: () => null },
    { getDrawPaneById: () => ({}) },
    { getDrawPaneById: () => ({ getAxisComponent: () => ({}) }) },
    { getDrawPaneById: () => { throw new Error('renamed') } },
    { getDrawPaneById: () => ({ getAxisComponent: () => ({ setAutoCalcTickFlag: () => { throw new Error('x') }, getAutoCalcTickFlag: () => { throw new Error('x') } }) }) },
    { adjustPaneViewport: () => { throw new Error('x') } },
  ]
  it.each(variants.map((v, i) => [i, v]))('variant %i', (_i, chart) => {
    expect(() => getCandleYAxis(chart as never)).not.toThrow()
    expect(() => setCandleYAxisAutoCalc(chart as never, true)).not.toThrow()
    expect(() => getCandleYAxisAutoCalc(chart as never)).not.toThrow()
    expect(() => adjustChartViewport(chart as never)).not.toThrow()
    expect(() => resetCandleYAxisAuto(chart as never)).not.toThrow()
  })
  it('still works when the API exists', () => {
    let flag = false
    const chart = { getDrawPaneById: () => ({ getAxisComponent: () => ({ setAutoCalcTickFlag: (f: boolean) => { flag = f }, getAutoCalcTickFlag: () => flag }) }) }
    expect(setCandleYAxisAutoCalc(chart as never, true)).toBe(true)
    expect(getCandleYAxisAutoCalc(chart as never)).toBe(true)
  })
})

describe('#5 history paging', () => {
  it('olderThan drops bars at/after the edge and sorts/dedupes', () => {
    const edge = Date.parse(bar(10).time)
    const out = olderThan([bar(12), bar(3), bar(10), bar(3), bar(1)], edge)
    expect(out.map(c => c.time)).toEqual([bar(1).time, bar(3).time])
  })
  it('a provider ignoring `end` yields nothing older (paging stops)', () => {
    expect(olderThan([bar(50), bar(51)], Date.parse(bar(50).time))).toEqual([])
  })
  it('ohlcv RPC accepts an end bound', () => {
    const r = readOhlcvRequest({ symbol: 'BTCUSDT', timeframe: '15m', end: Date.UTC(2026, 0, 1) })
    expect(typeof r).toBe('object')
    expect((r as { end?: string }).end).toBe('2026-01-01T00:00:00.000Z')
    expect(readOhlcvRequest({ symbol: 'BTCUSDT', timeframe: '15m', end: 'nope' })).toBe('end must be a timestamp')
  })
  it('series stay index-aligned after a prepend', () => {
    const recent = Array.from({ length: 80 }, (_, i) => bar(i + 80))
    const older = Array.from({ length: 80 }, (_, i) => bar(i))
    const p = candlesToPayload('sim', 'SIM', '15m', recent)
    const merged = withCandles(p, [...older, ...recent])
    const tf = enrichChartTimeframe(merged.timeframes[0]!)
    for (const col of ['macd_hist', 'rsi14', 'bb_upper']) expect(tf.series![col]).toHaveLength(160)
  })
})

describe('#6 label lanes on a log axis', () => {
  it('low-price labels far apart on log are not merged', () => {
    // 3000 and 3600: 0.6% of linear span but ~5% of log span (3000..100000) → still close;
    // 3000 vs 4500 is ~11.6% on log, only 1.5% linear.
    expect(assignLabelLanes([3000, 4500], 3000, 100000, 'normal')).toEqual([1, 0])
    expect(assignLabelLanes([3000, 4500], 3000, 100000, 'log')).toEqual([0, 0])
  })
  it('high-price labels crowded on log step aside', () => {
    expect(assignLabelLanes([90000, 96000], 3000, 100000, 'normal')).toEqual([0, 0])
    expect(assignLabelLanes([90000, 96000], 3000, 100000, 'log')).toEqual([1, 0])
  })
})

describe('#7 NW draw batches same-trend runs', () => {
  it('groups consecutive bars by direction', () => {
    const r = (b: boolean) => ({ isBullish: b, value: 1 }) as never
    expect(nwTrendRuns([r(true), r(true), r(false), r(false), r(false), r(true)], 0, 5)).toEqual([
      { start: 0, end: 1, bullish: true }, { start: 2, end: 4, bullish: false }, { start: 5, end: 5, bullish: true },
    ])
  })
  it('a missing bar breaks a run', () => {
    const r = { isBullish: true, value: 1 } as never
    expect(nwTrendRuns([r, undefined, r], 0, 2)).toHaveLength(2)
    // Pine na (value undefined) also breaks a run
    expect(nwTrendRuns([r, { isBullish: true } as never, r], 0, 2)).toHaveLength(2)
  })
})

describe('#8 MTF S/R and 1M (by design)', () => {
  it('1M stays unknown on purpose; calc skips every MTF slot for a monthly source', () => {
    expect(mtfSourceTimeframeSeconds('1M')).toBeUndefined()
    expect(mtfSourceTimeframeSeconds('1m')).toBe(60)
  })
})
