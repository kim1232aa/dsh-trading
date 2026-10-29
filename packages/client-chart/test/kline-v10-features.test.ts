import { describe, expect, it } from 'vitest'
import {
  USER_DRAW_GROUP,
  LEFT_Y_AXIS_ID,
  createCandleDataLoader,
  toKLineData,
  periodFromTimeframe,
  yAxisNameForCoord,
  __resetChartThemesForTest,
} from '../src/client/kline-v10.js'

const bars = (n: number, startMs: number, stepMs: number) =>
  Array.from({ length: n }, (_, i) => ({
    time: new Date(startMs + i * stepMs).toISOString(),
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10,
  }))

describe('createCandleDataLoader forward/backward', () => {
  it('init advertises forward when loadOlder is set, backward when loadNewer is set', () => {
    const all = bars(5, Date.parse('2026-01-01T00:00:00Z'), 3_600_000)
    let got: unknown
    const loader = createCandleDataLoader({
      getCandles: () => all,
      loadOlder: async () => [],
      loadNewer: async () => [],
    })
    loader.getBars({
      type: 'init',
      timestamp: null,
      symbol: { ticker: 'T' },
      period: { span: 1, type: 'hour' },
      callback: (data, more) => { got = { n: data.length, more } },
    } as never)
    expect((got as { n: number }).n).toBe(5)
    expect((got as { more: object }).more).toEqual({ forward: true, backward: true })
  })

  it('forward loads older bars before timestamp', async () => {
    const all = bars(10, Date.parse('2026-01-01T00:00:00Z'), 3_600_000)
    const mid = Date.parse(all[5]!.time)
    let result: { n: number; forward?: boolean } | undefined
    let committed = 0
    const loader = createCandleDataLoader({
      getCandles: () => all.slice(5),
      loadOlder: async (before) => {
        expect(before).toBe(mid)
        return all.slice(0, 5)
      },
      commitOlder: (rows) => { committed = rows.length },
    })
    await new Promise<void>((resolve) => {
      loader.getBars({
        type: 'forward',
        timestamp: mid,
        symbol: { ticker: 'T' },
        period: { span: 1, type: 'hour' },
        callback: (data, more) => {
          result = { n: data.length, ...(typeof more === 'object' && more ? more : {}) }
          resolve()
        },
      } as never)
    })
    expect(result?.n).toBe(5)
    expect(result?.forward).toBe(true)
    expect(committed).toBe(5)
  })

  it('backward loads newer bars after timestamp', async () => {
    const all = bars(10, Date.parse('2026-01-01T00:00:00Z'), 3_600_000)
    const mid = Date.parse(all[4]!.time)
    let result: { n: number; backward?: boolean } | undefined
    let committed = 0
    const loader = createCandleDataLoader({
      getCandles: () => all.slice(0, 5),
      loadNewer: async (after) => {
        expect(after).toBe(mid)
        return all.slice(5)
      },
      commitNewer: (rows) => { committed = rows.length },
    })
    await new Promise<void>((resolve) => {
      loader.getBars({
        type: 'backward',
        timestamp: mid,
        symbol: { ticker: 'T' },
        period: { span: 1, type: 'hour' },
        callback: (data, more) => {
          result = { n: data.length, ...(typeof more === 'object' && more ? more : {}) }
          resolve()
        },
      } as never)
    })
    expect(result?.n).toBe(5)
    expect(result?.backward).toBe(true)
    expect(committed).toBe(5)
  })

  it('backward without loadNewer returns empty', () => {
    let got: unknown
    const loader = createCandleDataLoader({ getCandles: () => bars(2, 0, 1000) })
    loader.getBars({
      type: 'backward',
      timestamp: 1000,
      symbol: { ticker: 'T' },
      period: { span: 1, type: 'minute' },
      callback: (data, more) => { got = { n: data.length, more } },
    } as never)
    expect(got).toEqual({ n: 0, more: false })
  })
})

describe('helpers', () => {
  it('exports draw group and left y ids', () => {
    expect(USER_DRAW_GROUP).toBe('dsh-user-draw')
    expect(LEFT_Y_AXIS_ID).toBe('dsh-left-y')
  })
  it('toKLineData / period / yAxis mapping', () => {
    const k = toKLineData({ time: '2026-01-01T00:00:00.000Z', open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 })
    expect(k.close).toBe(1.5)
    expect(k.volume).toBe(9)
    expect(periodFromTimeframe('1h')).toEqual({ span: 1, type: 'hour' })
    expect(yAxisNameForCoord('log')).toBe('logarithm')
    __resetChartThemesForTest()
  })
})
