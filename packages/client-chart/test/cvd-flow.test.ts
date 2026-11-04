import { describe, expect, it } from 'vitest'
import { calcCvdRows } from '../src/client/indicators/cvd-flow.js'
import { mergeCvdBars } from '../src/client/market-client.js'

const T0 = Date.parse('2026-11-04T00:00:00.000Z')
const M = 300_000
const k = (i: number, high: number, low: number, close: number) => ({ timestamp: T0 + i * M, high, low, close })
const bar = (i: number, perp: number | null, spot: number | null) => ({ time: new Date(T0 + i * M).toISOString(), perp, spot })

describe('calcCvdRows', () => {
  it('accumulates each book from its first bar and aligns by time, not index', () => {
    const list = [k(0, 2, 1, 1.5), k(1, 2, 1, 1.5), k(2, 2, 1, 1.5)]
    const rows = calcCvdRows(list, [bar(2, 5, 1), bar(1, 10, null), bar(0, -4, 2)], 2, 1)
    expect(rows.map(r => r.perp)).toEqual([-4, 6, 11])
    expect(rows.map(r => r.spot)).toEqual([2, 2, 3]) // missing spot delta keeps the running total
    expect(rows[1]!.spotDelta).toBeUndefined()
  })

  it('draws nothing for bars outside the fetched window', () => {
    const rows = calcCvdRows([k(0, 2, 1, 1), k(1, 2, 1, 1)], [bar(1, 3, 3)], 2, 1)
    expect(rows[0]).toEqual({})
    expect(rows[1]!.perp).toBe(3)
  })

  it('maps spot onto the perp axis for drawing', () => {
    const list = [k(0, 2, 1, 1), k(1, 2, 1, 1), k(2, 2, 1, 1)]
    const rows = calcCvdRows(list, [bar(0, 0, 0), bar(1, 100, 1), bar(2, 100, 1)], 2, 1)
    expect(rows.map(r => r.spotScaled)).toEqual([0, 100, 200])
  })

  it('flags 现货顶背离: higher high, lower spot CVD than at the prior high', () => {
    // bar 2 = prior high 110 with spot CVD 30; bar 5 = new high 112 with spot CVD 10.
    const highs = [100, 105, 110, 104, 106, 112, 108]
    const spot = [10, 10, 10, -10, -5, -5, 0]
    const list = highs.map((h, i) => k(i, h, h - 5, h - 1))
    const rows = calcCvdRows(list, highs.map((_, i) => bar(i, 1, spot[i]!)), 4, 1)
    expect(rows[5]!.signals).toContainEqual({ kind: '现货顶背离', bearish: true })
    expect(rows.flatMap(r => r.signals ?? []).filter(s => s.kind === '现货顶背离')).toHaveLength(1)
  })

  it('flags 合约CVD停涨 when perp buying stops near the high, and 停跌 mirrored', () => {
    const up = [10, 10, 10, 30, 30, 30, -5, -5, -5, 0]
    const price = [100, 101, 102, 104, 106, 108, 108.5, 108.2, 108.4, 108]
    const list = price.map((p, i) => k(i, p + 0.5, p - 0.5, p))
    const rows = calcCvdRows(list, up.map((d, i) => bar(i, d, null)), 6, 3)
    const kinds = rows.map(r => (r.signals ?? []).map(s => s.kind)).flat()
    expect(kinds).toContain('合约CVD停涨')
    const down = calcCvdRows(price.map((p, i) => k(i, 200 - p + 0.5, 200 - p - 0.5, 200 - p)), up.map((d, i) => bar(i, -d, null)), 6, 3)
    expect(down.flatMap(r => r.signals ?? []).map(s => s.kind)).toContain('合约CVD停跌')
  })

  it('never signals on the newest (forming) bar', () => {
    const highs = [100, 105, 110, 104, 106, 112]
    const spot = [10, 10, 10, -10, -5, -5]
    const rows = calcCvdRows(highs.map((h, i) => k(i, h, h - 5, h - 1)), highs.map((_, i) => bar(i, 1, spot[i]!)), 4, 1)
    expect(rows[5]!.signals).toBeUndefined()
  })
})

describe('mergeCvdBars', () => {
  it('replaces the forming bar and appends new ones in time order', () => {
    const merged = mergeCvdBars([bar(0, 1, 1), bar(1, 2, 2)], [bar(1, 5, 5), bar(2, 3, 3)])
    expect(merged.map(b => b.perp)).toEqual([1, 5, 3])
  })
})
