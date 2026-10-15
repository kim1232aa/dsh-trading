import { describe, expect, it } from 'vitest'
import type { Candle } from '@dsh-trading/market-data'
import { detectSupplyDemandZones, type SupplyDemandOptions } from '../src/supply-demand.js'

function bar(i: number, open = 100, high = 102, low = 98, close = 100): Candle {
  return { time: new Date(Date.UTC(2026, 0, 1, 0, i * 5)).toISOString(), open, high, low, close, volume: 100 }
}
function setup(): Candle[] {
  return [...Array.from({ length: 14 }, (_, i) => bar(i)), bar(14, 100, 101, 99, 100.5)]
}
function supply(): Candle[] {
  return [...setup(), bar(15, 100, 100.5, 90, 91)]
}
const closed = { lastBarClosed: true }
function origin(bars: Candle[], options: SupplyDemandOptions = closed) {
  return detectSupplyDemandZones(bars, options).find(z => z.baseStart === 14 && z.kind === 'supply')
}

describe('supply/demand evidence, not swing-price bands', () => {
  it('records a contracted base followed by a closed displacement', () => {
    const z = origin(supply())!
    expect(z).toMatchObject({ kind: 'supply', low: 100, high: 101, baseStart: 14, baseEnd: 14,
      confirmedIndex: 15, baseStartTime: bar(14).time, baseEndTime: bar(14).time,
      confirmedAt: bar(15).time, status: 'fresh', testCount: 0, atr: 4 })
    expect(z.displacementAtr).toBe(2)
  })
  it('detects demand symmetrically without calling a lower swing supply', () => {
    const bars = supply().map(b => ({ ...b, open: 200 - b.open, close: 200 - b.close,
      high: 200 - b.low, low: 200 - b.high }))
    const z = detectSupplyDemandZones(bars, closed).find(z => z.baseStart === 14)!
    expect(z).toMatchObject({ kind: 'demand', low: 99, high: 100, status: 'fresh' })
  })
  it('does not invent a zone from an isolated high or a broken low', () => {
    const bars = [...setup(), bar(15, 100, 110, 99, 100)]
    expect(origin(bars)).toBeUndefined()
  })
  it('rejects a weak departure and an uncontracted base', () => {
    expect(origin([...setup(), bar(15, 100, 101, 97, 98)])).toBeUndefined()
    const bars = supply()
    bars[14] = bar(14, 100, 105, 95, 100.5)
    expect(origin(bars)).toBeUndefined()
  })
  it('does not confirm a large wick that closes back at the base', () => {
    expect(origin([...setup(), bar(15, 100, 101, 85, 99)])).toBeUndefined()
  })
  it('uses the base volatility, not the outgoing crash, to measure departure', () => {
    expect(origin(supply())!.atr).toBe(4)
    expect(origin(supply())!.displacementAtr).toBeGreaterThanOrEqual(1.5)
  })
  it('does not confirm or invalidate from the forming candle', () => {
    expect(origin(supply(), {})).toBeUndefined()
    const bars = [...supply(), bar(16, 91, 120, 90, 115)]
    expect(origin(bars, {})!.status).toBe('fresh')
    expect(origin(bars)!.status).toBe('invalidated')
  })
  it('counts independent return episodes rather than adjacent candles', () => {
    const bars = [...supply(), bar(16, 95, 100.4, 94, 99), bar(17, 99, 100.5, 98, 99),
      bar(18, 99, 99.5, 92, 93), bar(19, 93, 100.4, 92, 99)]
    expect(origin(bars)).toMatchObject({ status: 'tested', testCount: 2 })
  })
  it('keeps a wick excursion as a test and invalidates only a closed distal break', () => {
    const tested = [...supply(), bar(16, 95, 105, 94, 99)]
    expect(origin(tested)).toMatchObject({ status: 'tested', testCount: 1 })
    const broken = [...tested, bar(17, 99, 103, 98, 102), bar(18, 102, 103, 90, 91)]
    expect(origin(broken)).toMatchObject({ status: 'invalidated', invalidatedAt: bar(17).time, testCount: 1 })
  })
  it('never reactivates an invalidated zone when price falls back below it', () => {
    const bars = [...supply(), bar(16, 99, 105, 98, 104), bar(17, 104, 105, 90, 91)]
    expect(origin(bars)!.status).toBe('invalidated')
  })
  it('does not backfill formation or alter its bounds when later candles arrive', () => {
    const initial = origin(supply())!
    const later = origin([...supply(), bar(16, 91, 95, 89, 93), bar(17, 93, 97, 92, 96)])!
    for (const key of ['id', 'low', 'high', 'baseStartTime', 'baseEndTime', 'confirmedAt', 'atr'] as const) {
      expect(later[key]).toBe(initial[key])
    }
    expect(origin(supply().slice(0, -1))).toBeUndefined()
  })
  it('retains price scale and avoids a fixed decimal rounding floor', () => {
    const scale = 1e-10
    const bars = supply().map(b => ({ ...b, open: b.open * scale, high: b.high * scale,
      low: b.low * scale, close: b.close * scale }))
    const z = origin(bars)!
    expect(z.low).toBeCloseTo(100 * scale, 18)
    expect(z.high).toBeGreaterThan(z.low)
    expect(z.displacementAtr).toBeCloseTo(2)
  })
  it('rejects invalid candle geometry and invalid rule parameters', () => {
    const bars = supply()
    bars[14] = bar(14, 105, 101, 99, 100)
    expect(() => detectSupplyDemandZones(bars, closed)).toThrow(/OHLC/)
    expect(() => detectSupplyDemandZones(supply(), { atrPeriod: 0 })).toThrow(/atrPeriod/)
  })
})
