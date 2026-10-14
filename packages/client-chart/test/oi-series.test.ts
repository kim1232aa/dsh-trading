import { describe, expect, it } from 'vitest'
import { contractOpenInterest, postureColor } from '../src/client/market-client.js'
import type { PanelDerivativeBar } from '../src/client/market-client.js'
import {
  calcLsrRatioRows,
  calcOiPostureRows,
  matchDerivativeHistory,
} from '../src/client/ChartCard.js'

describe('contractOpenInterest', () => {
  it('plots contracts, never the USD value that rises when price spikes', () => {
    expect(contractOpenInterest({ openInterest: 2_280_000 })).toBe(2_280_000)
    expect(contractOpenInterest({ openInterest: null })).toBeNull()
    expect(contractOpenInterest({})).toBeNull()
  })

  it('colors the four quadrant labels that the strip shows', () => {
    expect(postureColor('强多头').color).toBe('#3ddc97')
    expect(postureColor('强空头').color).toBe('#f47067')
    expect(postureColor('弱反弹 / 轧空').color).toBe('#d2a8ff')
    expect(postureColor('多头踩踏').color).toBe('#d2a8ff')
  })
})

function bar(partial: Partial<PanelDerivativeBar> & { time: string }): PanelDerivativeBar {
  return {
    openInterest: null,
    openInterestValue: null,
    longShortRatio: null,
    takerBuySellRatio: null,
    ...partial,
  }
}

describe('OI_POSTURE / LSR_RATIO series', () => {
  const t0 = Date.parse('2026-10-15T00:00:00Z')
  const history: PanelDerivativeBar[] = [
    bar({
      time: '2026-10-15T00:00:00.000Z',
      openInterest: 90_000,
      openInterestValue: 7_500_000_000,
      longShortRatio: 1.40,
      topPositionRatio: 1.55,
      topAccountRatio: 1.48,
      posture: '价跌增仓',
    }),
    bar({
      time: '2026-10-15T00:15:00.000Z',
      openInterest: 92_000,
      openInterestValue: 7_600_000_000,
      longShortRatio: 1.42,
      topPositionRatio: 0.95,
      topAccountRatio: 1.50,
      posture: '价涨增仓',
    }),
  ]
  const candles = [
    { timestamp: t0 },
    { timestamp: t0 + 15 * 60_000 },
    { timestamp: t0 + 30 * 60_000 }, // no match within 15m of a sparsely spaced hist? 30m from last is 15m - borderline
  ]

  it('matchDerivativeHistory picks the nearest bar within 15 minutes', () => {
    expect(matchDerivativeHistory(history, t0)?.openInterest).toBe(90_000)
    expect(matchDerivativeHistory(history, t0 + 15 * 60_000)?.longShortRatio).toBe(1.42)
    expect(matchDerivativeHistory(history, t0 + 40 * 60_000)).toBeUndefined()
  })

  it('OI_POSTURE draws coin OI + MA only (ratios are not figure keys)', () => {
    const rows = calcOiPostureRows(candles.slice(0, 2), history, 2)
    expect(rows[0]?.oi).toBe(90_000)
    expect(rows[1]?.oi).toBe(92_000)
    expect(rows[1]?.oiMa).toBe(91_000)
    expect(rows[1]?.deltaOi).toBe(2_000)
    expect(rows[0]).not.toHaveProperty('lsr')
    expect(Object.keys(rows[1]!).sort()).toEqual(['bar', 'deltaOi', 'oi', 'oiMa'].sort())
  })

  it('LSR_RATIO draws account ratio + top position ratio with mid=1 boundary', () => {
    const rows = calcLsrRatioRows(candles.slice(0, 2), history)
    expect(rows[0]).toEqual(expect.objectContaining({ lsr: 1.40, topPos: 1.55, mid: 1 }))
    expect(rows[1]).toEqual(expect.objectContaining({ lsr: 1.42, topPos: 0.95, mid: 1 }))
    // >1 net-long / <1 net-short is a display convention on the drawn values
    expect(rows[0]!.lsr!).toBeGreaterThan(1)
    expect(rows[1]!.topPos!).toBeLessThan(1)
  })

  it('empty history yields empty rows for both indicators', () => {
    expect(calcOiPostureRows(candles, [], 14)).toEqual([{}, {}, {}])
    expect(calcLsrRatioRows(candles, [])).toEqual([{}, {}, {}])
  })
})

import { derivativesAtBar } from '../src/client/market-client.js'

describe('historical hover never falls back to live', () => {
  const live = {
    source: 'OKX', openInterest: 1, openInterestValue: 1, fundingRate: 0.0001, nextFundingTime: null,
    longShortRatio: 1.9, topPositionRatio: 0.9, topAccountRatio: 1.3, takerBuySellRatio: 1.4,
    time: '2026-10-15T01:00:00Z', posture: 'LIVE', quadrant: '强多头', quadrantNote: 'live note',
    oiChangePct1h: 2, priceChangePct1h: 1,
  }
  it('missing history values stay null; posture/quadrant come from the bar', () => {
    const t = derivativesAtBar(live, bar({ time: '2026-10-15T00:00:00Z', openInterest: 5, posture: '多头平仓' }))
    expect(t.longShortRatio).toBeNull()
    expect(t.topPositionRatio).toBeNull()
    expect(t.topAccountRatio).toBeNull()
    expect(t.takerBuySellRatio).toBeNull()
    expect(t.openInterestValue).toBeNull()
    expect(t.posture).toBe('多头平仓')
    expect(t.quadrant).toBeNull()
    expect(t.quadrantNote).toBeNull()
    expect(t.oiChangePct1h).toBeNull()
    expect(t.isHistorical).toBe(true)
    expect(t.fundingRate).toBe(0.0001) // funding is snapshot-only, labelled live
  })
})

describe('matchDerivativeHistory on large bars', () => {
  const h0 = Date.parse('2026-10-15T00:00:00Z')
  const hist = Array.from({ length: 12 }, (_, i) => bar({ time: new Date(h0 + i * 300_000).toISOString(), openInterest: i }))
  it('picks the last snapshot inside the candle interval', () => {
    expect(matchDerivativeHistory(hist, h0, 3600_000)?.openInterest).toBe(11)
    expect(matchDerivativeHistory(hist, h0 - 86_400_000, 86_400_000)).toBeUndefined()
    // default behaviour unchanged
    expect(matchDerivativeHistory(hist, h0)?.openInterest).toBe(0)
  })
})
