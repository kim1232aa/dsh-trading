import { describe, expect, it } from 'vitest'
import { readChartPayload, type ChartPayload } from '../src/client/payload.js'
import { mergeMarks, readMarks } from '../src/client/market-client.js'

function payload(): ChartPayload {
  return { kind: 'chart', version: 1, provider: 'fixture', symbol: 'DEMO', timeframes: [{
    timeframe: '5m', indicators: null,
    candles: [0, 1, 2].map(i => ({ time: new Date(Date.UTC(2026, 0, 1, 0, i * 5)).toISOString(),
      open: 100, high: 102, low: 98, close: 100, volume: 100 })),
    annotations: [],
  }] }
}

describe('authoritative candidate lifecycle results', () => {
  it('carries an explicit empty replacement across the metadata parser', () => {
    const parsed = readChartPayload({ ...payload(), replaceMarks: true })
    expect(parsed?.replaceMarks).toBe(true)
    const empty = readMarks(parsed)
    expect(empty).not.toBeNull()
    expect(empty?.annotations).toEqual([])
  })
  it('replaces a stale candidate with zero marks after invalidation', () => {
    const own = payload()
    const stale = readMarks({ ...own, timeframes: [{ ...own.timeframes[0]!, annotations: [{
      type: 'zone', low: 100, high: 101, role: 'resistance', label: '供给候选', sources: ['fixture'],
    }] }] })!
    const cleared = readMarks(readChartPayload({ ...own, replaceMarks: true }))
    expect(cleared).not.toBeNull()
    expect(cleared?.key).not.toBe(stale.key)
    const merged = mergeMarks(own, cleared!)
    expect(merged.kept).toBe(0)
    expect(merged.payload.timeframes[0]?.annotations ?? []).toEqual([])
  })
  it('does not show a candidate until its availability bar exists in the target data', () => {
    const own = payload()
    const bar = (i: number) => ({ ...own.timeframes[0]!.candles[0]!,
      time: new Date(Date.UTC(2026, 0, 1, 0, i * 5)).toISOString() })
    own.timeframes[0]!.candles = Array.from({ length: 31 }, (_, i) => bar(i))
    const source = { ...own, timeframes: [{ ...own.timeframes[0]!,
      candles: [...own.timeframes[0]!.candles, bar(31)], annotations: [{
        type: 'zone', low: 100, high: 101, role: 'resistance', label: '供给候选', sources: ['fixture'],
        startTime: bar(14).time, confirmedAt: bar(30).time, availableAt: bar(31).time,
      }],
    }] }
    const marks = readMarks(source)!
    expect(mergeMarks(own, marks)).toMatchObject({ kept: 0, dropped: 1 })
    expect(mergeMarks({ ...own, timeframes: [{ ...own.timeframes[0]!, candles: source.timeframes[0]!.candles }] }, marks))
      .toMatchObject({ kept: 1, dropped: 0 })
  })
  it('keeps ordinary snapshots from erasing user drawings', () => {
    expect(readMarks(readChartPayload(payload()))).toBeNull()
    expect(readMarks(readChartPayload({ ...payload(), replaceMarks: 'true' }))).toBeNull()
  })
})
