import { describe, expect, it } from 'vitest'
import {
  calculateOrderBlocks,
  orderBlockBreaker,
  orderBlockIndicator,
  type Candle,
} from '../src/client/indicators/order-blocks.js'

describe('calculateOrderBlocks', () => {
  it('returns empty array on empty candle input', () => {
    expect(calculateOrderBlocks([])).toEqual([])
  })

  it('detects a bullish order block with immediate structure break (displacement)', () => {
    // We construct candles where:
    // 0..10: establish a swing high at bar 5 (left=3, right=3 for small swing window)
    // swingL=3, swingR=3 -> pivot confirmed at bar 5 + 3 = bar 8.
    const candles: Candle[] = [
      { open: 100, high: 102, low: 99, close: 101 }, // 0
      { open: 101, high: 103, low: 100, close: 102 }, // 1
      { open: 102, high: 104, low: 101, close: 103 }, // 2
      { open: 103, high: 105, low: 102, close: 104 }, // 3
      { open: 104, high: 106, low: 103, close: 105 }, // 4
      { open: 105, high: 110, low: 104, close: 108 }, // 5: Swing High = 110
      { open: 108, high: 107, low: 103, close: 105 }, // 6
      { open: 105, high: 106, low: 102, close: 104 }, // 7
      { open: 104, high: 105, low: 101, close: 102 }, // 8: pivot high confirmed (swHigh = 110)
      // Now set up 4-step Bullish Order Block:
      // Bar 9 = Candle 0 (swept candle)
      { open: 102, high: 103, low: 99, close: 100 }, // 9 (low = 99)
      // Bar 10 = Candle 1 (OB candle): sweeps Candle 0 low (97 < 99)
      { open: 100, high: 101, low: 97, close: 99 }, // 10: OB top=101, bot=97
      // Bar 11 = Candle 2 (Displacement): closes above swHigh (112 > 110)
      { open: 99, high: 113, low: 98, close: 112 }, // 11: break swHigh!
      // Bar 12 = Candle 3 (FVG completion): low 103 > Candle 1 high 101
      { open: 112, high: 115, low: 103, close: 114 }, // 12: FVG gap [101, 103]
    ]

    const res = calculateOrderBlocks(candles, { swingL: 3, swingR: 3, candleLen: 50 })
    expect(res).toHaveLength(13)

    // At bar 12, bullish OB should be confirmed fresh!
    const bar12 = res[12]!
    expect(bar12.signals.bullOB).toBe(true)
    expect(bar12.activeZones.length).toBeGreaterThan(0)

    const ob = bar12.activeZones.find(z => z.obBar === 10)
    expect(ob).toBeDefined()
    expect(ob!.state).toBe('fresh')
    expect(ob!.dir).toBe(1)
    expect(ob!.polarity).toBe('bullish')
    expect(ob!.top).toBe(101)
    expect(ob!.bot).toBe(97)
    expect(ob!.fvgFar).toBe(103)
    expect(ob!.swPrice).toBe(110)
    expect(ob!.confirmBar).toBe(11) // broken on bar 11
    expect(bar12.bullOB).toBe((101 + 97) / 2)
  })

  it('detects a bearish order block with immediate structure break', () => {
    // swingL=3, swingR=3, establish swing low at bar 5
    const candles: Candle[] = [
      { open: 100, high: 101, low: 98, close: 99 }, // 0
      { open: 99, high: 100, low: 97, close: 98 }, // 1
      { open: 98, high: 99, low: 96, close: 97 }, // 2
      { open: 97, high: 98, low: 95, close: 96 }, // 3
      { open: 96, high: 97, low: 94, close: 95 }, // 4
      { open: 95, high: 96, low: 90, close: 92 }, // 5: Swing Low = 90
      { open: 92, high: 94, low: 91, close: 93 }, // 6
      { open: 93, high: 95, low: 92, close: 94 }, // 7
      { open: 94, high: 96, low: 93, close: 95 }, // 8: pivot low confirmed (swLow = 90)
      // Bearish Order Block sequence:
      // Bar 9: Candle 0 (high = 97)
      { open: 95, high: 97, low: 94, close: 96 }, // 9
      // Bar 10: Candle 1 (OB candle): sweeps Candle 0 high (99 > 97)
      { open: 96, high: 99, low: 95, close: 97 }, // 10: top=99, bot=95
      // Bar 11: Candle 2 (Displacement): closes below swLow (88 < 90)
      { open: 97, high: 98, low: 87, close: 88 }, // 11: dnBreak!
      // Bar 12: Candle 3 (FVG completion): high 93 < Candle 1 low 95
      { open: 88, high: 93, low: 86, close: 87 }, // 12: FVG gap [93, 95]
    ]

    const res = calculateOrderBlocks(candles, { swingL: 3, swingR: 3, candleLen: 50 })
    const bar12 = res[12]!

    expect(bar12.signals.bearOB).toBe(true)
    const bearOB = bar12.activeZones.find(z => z.obBar === 10)
    expect(bearOB).toBeDefined()
    expect(bearOB!.state).toBe('fresh')
    expect(bearOB!.dir).toBe(-1)
    expect(bearOB!.polarity).toBe('bearish')
    expect(bearOB!.top).toBe(99)
    expect(bearOB!.bot).toBe(95)
    expect(bearOB!.fvgFar).toBe(93)
    expect(bearOB!.swPrice).toBe(90)
    expect(bar12.bearOB).toBe((99 + 95) / 2)
  })

  it('drops pending zone when price trades back into zone during wait (violates clean zone)', () => {
    // Imbalance completes at bar 12, but no structure break yet -> zone is PENDING.
    // At bar 13, price dips into zone (low <= top for bull OB) -> dropped!
    const candles: Candle[] = [
      { open: 100, high: 102, low: 99, close: 101 }, // 0
      { open: 101, high: 103, low: 100, close: 102 }, // 1
      { open: 102, high: 104, low: 101, close: 103 }, // 2
      { open: 103, high: 105, low: 102, close: 104 }, // 3
      { open: 104, high: 106, low: 103, close: 105 }, // 4
      { open: 105, high: 120, low: 104, close: 108 }, // 5: Swing High = 120 (unbroken)
      { open: 108, high: 107, low: 103, close: 105 }, // 6
      { open: 105, high: 106, low: 102, close: 104 }, // 7
      { open: 104, high: 105, low: 101, close: 102 }, // 8: pivot high confirmed (swHigh = 120)
      { open: 102, high: 103, low: 99, close: 100 }, // 9
      { open: 100, high: 101, low: 97, close: 99 }, // 10: OB top=101, bot=97
      { open: 99, high: 110, low: 98, close: 109 }, // 11: does NOT break 120
      { open: 109, high: 112, low: 103, close: 111 }, // 12: FVG gap [101, 103], PENDING
      { open: 111, high: 111, low: 100, close: 105 }, // 13: low 100 <= top 101 -> VIOLATES clean zone!
    ]

    const res = calculateOrderBlocks(candles, { swingL: 3, swingR: 3, candleLen: 50 })
    // At bar 12, zone is pending (not in activeZones because pending zones are not drawn)
    expect(res[12]!.activeZones).toHaveLength(0)
    // At bar 13, zone trades back into zone -> dropped, never confirmed
    expect(res[13]!.activeZones).toHaveLength(0)
    expect(res[13]!.counts.freshBull).toBe(0)
  })

  it('confirms pending zone when structure breaks during wait window', () => {
    // Imbalance completes at bar 12 (swHigh = 110 unbroken).
    // Bar 13 stays clean.
    // Bar 14 breaks swHigh (close 112 > 110). Zone becomes FRESH!
    const candles: Candle[] = [
      { open: 100, high: 102, low: 99, close: 101 }, // 0
      { open: 101, high: 103, low: 100, close: 102 }, // 1
      { open: 102, high: 104, low: 101, close: 103 }, // 2
      { open: 103, high: 105, low: 102, close: 104 }, // 3
      { open: 104, high: 106, low: 103, close: 105 }, // 4
      { open: 105, high: 110, low: 104, close: 108 }, // 5: Swing High = 110
      { open: 108, high: 107, low: 103, close: 105 }, // 6
      { open: 105, high: 106, low: 102, close: 104 }, // 7
      { open: 104, high: 105, low: 101, close: 102 }, // 8: pivot high confirmed (swHigh = 110)
      { open: 102, high: 103, low: 99, close: 100 }, // 9
      { open: 100, high: 101, low: 97, close: 99 }, // 10: OB top=101, bot=97
      { open: 99, high: 105, low: 98, close: 104 }, // 11
      { open: 104, high: 106, low: 103, close: 105 }, // 12: FVG gap [101, 103], PENDING
      { open: 105, high: 108, low: 104, close: 107 }, // 13: stays clean (low 104 > top 101)
      { open: 107, high: 113, low: 106, close: 112 }, // 14: breaks 110! Confirmed!
    ]

    const res = calculateOrderBlocks(candles, { swingL: 3, swingR: 3, candleLen: 50, waitBars: 5 })
    expect(res[13]!.activeZones).toHaveLength(0)
    expect(res[14]!.signals.bullOB).toBe(true)
    expect(res[14]!.activeZones).toHaveLength(1)
    expect(res[14]!.activeZones[0]!.state).toBe('fresh')
    expect(res[14]!.activeZones[0]!.confirmBar).toBe(14)
  })

  it('tracks full zone lifecycle: Fresh -> Mitigated -> Breaker Block', () => {
    // 0..12: creates fresh bullish OB (top=101, bot=97)
    const baseCandles: Candle[] = [
      { open: 100, high: 102, low: 99, close: 101 }, // 0
      { open: 101, high: 103, low: 100, close: 102 }, // 1
      { open: 102, high: 104, low: 101, close: 103 }, // 2
      { open: 103, high: 105, low: 102, close: 104 }, // 3
      { open: 104, high: 106, low: 103, close: 105 }, // 4
      { open: 105, high: 110, low: 104, close: 108 }, // 5: Swing High = 110
      { open: 108, high: 107, low: 103, close: 105 }, // 6
      { open: 105, high: 106, low: 102, close: 104 }, // 7
      { open: 104, high: 105, low: 101, close: 102 }, // 8: pivot high confirmed
      { open: 102, high: 103, low: 99, close: 100 }, // 9
      { open: 100, high: 101, low: 97, close: 99 }, // 10: OB top=101, bot=97
      { open: 99, high: 113, low: 98, close: 112 }, // 11: breaks swHigh
      { open: 112, high: 115, low: 103, close: 114 }, // 12: FVG completed, FRESH OB!
    ]

    // Bar 13: Price taps into zone: low 100 <= top 101, but close 102 >= bot 97 -> MITIGATED!
    const tapCandle: Candle = { open: 114, high: 114, low: 100, close: 102 }

    // Bar 14: Price closes through far side: close 95 < bot 97 -> BREAKER!
    const breakCandle: Candle = { open: 102, high: 103, low: 94, close: 95 }

    const candles = [...baseCandles, tapCandle, breakCandle]
    const res = calculateOrderBlocks(candles, { swingL: 3, swingR: 3, candleLen: 50 })

    // Bar 12: Fresh
    expect(res[12]!.activeZones[0]!.state).toBe('fresh')
    expect(res[12]!.counts.freshBull).toBe(1)
    expect(res[12]!.counts.mitBull).toBe(0)

    // Bar 13: Mitigated
    expect(res[13]!.signals.bullMit).toBe(true)
    expect(res[13]!.activeZones[0]!.state).toBe('mitigated')
    expect(res[13]!.counts.freshBull).toBe(0)
    expect(res[13]!.counts.mitBull).toBe(1)

    // Bar 14: Breaker (polarity flips to bearish breaker!)
    expect(res[14]!.signals.bearBB).toBe(true)
    expect(res[14]!.activeZones[0]!.state).toBe('breaker')
    expect(res[14]!.activeZones[0]!.polarity).toBe('bearish')
    expect(res[14]!.activeZones[0]!.tag).toBe('Bearish Breaker')
    expect(res[14]!.breaker).toBe((101 + 97) / 2)
    expect(res[14]!.counts.bbBear).toBe(1)
  })

  it('handles same-bar tap and break: transitions Fresh directly to Breaker', () => {
    const candles: Candle[] = [
      { open: 100, high: 102, low: 99, close: 101 }, // 0
      { open: 101, high: 103, low: 100, close: 102 }, // 1
      { open: 102, high: 104, low: 101, close: 103 }, // 2
      { open: 103, high: 105, low: 102, close: 104 }, // 3
      { open: 104, high: 106, low: 103, close: 105 }, // 4
      { open: 105, high: 110, low: 104, close: 108 }, // 5: Swing High = 110
      { open: 108, high: 107, low: 103, close: 105 }, // 6
      { open: 105, high: 106, low: 102, close: 104 }, // 7
      { open: 104, high: 105, low: 101, close: 102 }, // 8
      { open: 102, high: 103, low: 99, close: 100 }, // 9
      { open: 100, high: 101, low: 97, close: 99 }, // 10: OB top=101, bot=97
      { open: 99, high: 113, low: 98, close: 112 }, // 11: breaks swHigh
      { open: 112, high: 115, low: 103, close: 114 }, // 12: Fresh OB
      // Bar 13 dips into zone (low 95 <= 101) AND closes below bot (close 96 < 97)
      { open: 114, high: 114, low: 95, close: 96 }, // 13: same-bar breaker flip!
    ]

    const res = calculateOrderBlocks(candles, { swingL: 3, swingR: 3, candleLen: 50 })
    expect(res[13]!.signals.bullMit).toBe(true)
    expect(res[13]!.signals.bearBB).toBe(true)
    expect(res[13]!.activeZones[0]!.state).toBe('breaker')
    expect(res[13]!.breaker).toBe((101 + 97) / 2)
  })

  it('orderBlockBreaker provides backward compatible array', () => {
    const bars = [
      { high: 10, low: 5, close: 8 },
      { high: 11, low: 6, close: 9 },
      { high: 12, low: 7, close: 10 },
      { high: 13, low: 8, close: 11 },
    ]
    const out = orderBlockBreaker(bars)
    expect(out).toHaveLength(4)
    expect(Array.isArray(out)).toBe(true)
  })

  it('orderBlockIndicator registers with correct schema and tooltips', () => {
    expect(orderBlockIndicator.name).toBe('OB_BB')
    expect(orderBlockIndicator.series).toBe('price')
    expect(orderBlockIndicator.figures).toHaveLength(3)

    const tooltip = orderBlockIndicator.createTooltipDataSource({
      indicator: {
        result: [
          {
            bullOB: 100.5,
            bearOB: undefined,
            breaker: 95.2,
            counts: { freshBull: 1, freshBear: 0, mitBull: 0, mitBear: 0, bbBull: 0, bbBear: 1 },
            signals: { bullOB: false, bearOB: false, bullMit: false, bearMit: false, bullBB: false, bearBB: false },
            activeZones: [],
          },
        ],
      },
      crosshair: { dataIndex: 0 },
    })

    expect(tooltip.values).toHaveLength(2)
    expect(tooltip.values[0]!.title).toContain('买单块')
    expect(tooltip.values[0]!.value.text).toBe('100.50')
    expect(tooltip.values[1]!.title).toContain('破坏块')
    expect(tooltip.values[1]!.value.text).toBe('95.20')
  })
})
