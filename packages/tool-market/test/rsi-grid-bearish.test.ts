import { describe, expect, it } from 'vitest'
import { regimeSnapshot, renderSnapshot } from '../src/regime.js'
import { rsiGrid, rsiGridReport, rsiGridShortParams, rsiGridStateText, RSI_GRID_DEFAULTS, RSI_GRID_SHORT_DEFAULTS } from '../src/rsi-grid.js'
import type { RsiGridReport } from '../src/rsi-grid.js'

const values = [100, 101, 99, 102, 98, 103, 97, 104, 107, 110, 113, 116, 119, 122, 125, 121, 117, 113, 109, 105, 101, 97, 93, 89, 85]
const bars = values.map((close, i) => ({ time: new Date(Date.UTC(2024, 0, 1) + i * 60_000).toISOString(),
  open: values[Math.max(i - 1, 0)]!, high: Math.max(close, values[Math.max(i - 1, 0)]!) + 1,
  low: Math.min(close, values[Math.max(i - 1, 0)]!) - 1, close, volume: 100 }))

describe('default dual-sided RSI grid reporting', () => {
  it('derives short thresholds as the reflected long parameters, including custom inputs', () => {
    expect(rsiGridShortParams(RSI_GRID_DEFAULTS)).toEqual(RSI_GRID_SHORT_DEFAULTS)
    expect(rsiGridShortParams([9, 25, 65, 12])).toEqual([9, 35, 75, 12])
  })
  it('publishes and renders short observations by default, retaining explicit opt-out', () => {
    const snapshot = regimeSnapshot(bars)
    expect(snapshot.rsiGridShort).toEqual(rsiGridReport(bars, RSI_GRID_SHORT_DEFAULTS, 'short'))
    expect(renderSnapshot('1m', snapshot)).toContain('[空:')
    expect(regimeSnapshot(bars, null, null, null, { rsiGridShort: false }).rsiGridShort).toBeUndefined()
  })
  it('keeps the pre-existing short next-open fill and profitable exit behavior', () => {
    const result = rsiGrid(bars, ...RSI_GRID_SHORT_DEFAULTS, 'short', { closedOnly: true })
    expect(result.trades.length).toBeGreaterThan(0)
    for (const trade of result.trades) {
      expect(result.bars[trade.entryIndex - 1]!.signal).toBe('entry')
      expect(trade.entry).toBe(bars[trade.entryIndex]!.open)
      expect(result.bars[trade.exitIndex - 1]!.signal).toBe('exit')
      expect(trade.exit).toBe(bars[trade.exitIndex]!.open)
      expect(trade.exit).toBeLessThanOrEqual(trade.entry)
    }
  })
  it('retains numerical long/short accumulators in the default report', () => {
    const text = renderSnapshot('1m', regimeSnapshot(bars))
    expect(text).toContain('RSI7')
    expect(text).toContain('多差')
    expect(text).toContain('空差')
  })
  it('does not invent PnL when an older chart payload lacks it', () => {
    const legacy = { side: 'short', position: { entry: 120 } } as unknown as RsiGridReport
    expect(rsiGridStateText(legacy)).toBe('持空 @120')
    const flat = { side: 'short', rsi: 65, cum: 0, position: null } as unknown as RsiGridReport
    expect(rsiGridStateText(flat)).toBe('空仓')
    expect(rsiGridStateText({ ...flat, rsi: 75, cum: 5 })).toBe('超买累计 5/10')
  })
  it('reports pending exits before held-position state for both sides', () => {
    const report: RsiGridReport = { params: [...RSI_GRID_SHORT_DEFAULTS], side: 'short', rsi: 35, cum: 0,
      pending: 'exit', position: { entry: 120, barsHeld: 4, pnlPct: 10, side: 'short' },
      record: { closed: 0, wins: 0, avgPct: null } }
    expect(rsiGridStateText(report)).toBe('触发平空')
    expect(rsiGridStateText({ ...report, side: 'long', position: { ...report.position!, side: 'long' } })).toBe('触发平多')
  })
})
