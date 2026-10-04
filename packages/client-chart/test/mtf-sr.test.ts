import { describe, expect, it } from 'vitest'
import {
  calculateATR,
  calculateMtfSR,
  calculateStrengthScore,
  getStars,
  getTier,
  getTimeframeLabel,
  getTimeframeWeight,
  mtfSRIndicator,
  mtfSRZones,
  parseTimeframeSeconds,
  type Candle,
} from '../src/client/indicators/mtf-sr.js'

describe('MTF S/R Zones - Intraday MTF SR Pine Script v6 Port', () => {
  // Helper to generate a baseline flat series
  function makeBars(n: number, basePrice = 100): Candle[] {
    return Array.from({ length: n }, (_, i) => ({
      open: basePrice,
      high: basePrice + 1,
      low: basePrice - 1,
      close: basePrice,
      timestamp: i * 300_000,
    }))
  }

  describe('Math, Helpers & Formulas', () => {
    it('parses timeframe strings and seconds accurately', () => {
      expect(parseTimeframeSeconds('30')).toBe(1800)
      expect(parseTimeframeSeconds('60')).toBe(3600)
      expect(parseTimeframeSeconds('120')).toBe(7200)
      expect(parseTimeframeSeconds('240')).toBe(14400)
      expect(parseTimeframeSeconds('D')).toBe(86400)
      expect(parseTimeframeSeconds('1d')).toBe(86400)
      expect(parseTimeframeSeconds(1800)).toBe(1800)
    })

    it('formats timeframe labels per Pine specification', () => {
      expect(getTimeframeLabel(1800)).toBe('M30')
      expect(getTimeframeLabel(3600)).toBe('H1')
      expect(getTimeframeLabel(7200)).toBe('H2')
      expect(getTimeframeLabel(14400)).toBe('H4')
      expect(getTimeframeLabel(86400)).toBe('D1')
    })

    it('computes timeframe weight correctly', () => {
      expect(getTimeframeWeight(14400)).toBe(1.0)
      expect(getTimeframeWeight(3600)).toBe(0.78)
      expect(getTimeframeWeight(900)).toBe(0.55)
      expect(getTimeframeWeight(300)).toBe(0.38)
      expect(getTimeframeWeight(60)).toBe(0.30)
      expect(getTimeframeWeight(30)).toBe(0.25)
    })

    it('computes 0-10 strength score formula faithfully', () => {
      // Formula: (tfF*0.40 + cnfF*0.28 + wkF*0.18 + prF*0.14) * 10 + 0.9 * (cc - 1)
      // When tfW=1.0, cc=1, wick=0, prom=0, atr=10:
      // tfF=1.0, cnfF=0, wkF=0, prF=0 => raw = 0.40 => score = 4.0
      const scoreSingle = calculateStrengthScore(1.0, 1, 0, 0, 10)
      expect(scoreSingle).toBeCloseTo(4.0, 2)
      expect(getTier(scoreSingle)).toBe('WEAK')
      expect(getStars(scoreSingle)).toBe('★★')

      // Confluence bonus: cc=2 gives cnfF = 0.5, bonus = 0.9
      // raw = 0.40 + 0.5 * 0.28 = 0.54 => 5.4 + 0.9 = 6.3
      const scoreConf = calculateStrengthScore(1.0, 2, 0, 0, 10)
      expect(scoreConf).toBeCloseTo(6.3, 2)
      expect(getTier(scoreConf)).toBe('MODERATE')
      expect(getStars(scoreConf)).toBe('★★★')

      // High rejection wick & prominence:
      // wickAvg = 6.0 (atrv*0.6 = 6.0 => wkF = 1.0)
      // prom = 30.0 (atrv*3.0 = 30.0 => prF = 1.0)
      // cc = 3 (cnfF = 1.0, bonus = 1.8)
      // raw = 0.40 + 0.28 + 0.18 + 0.14 = 1.0 => 10.0 + 1.8 = 11.8 clamped to 10.0
      const scoreMax = calculateStrengthScore(1.0, 3, 6.0, 30.0, 10)
      expect(scoreMax).toBe(10.0)
      expect(getTier(scoreMax)).toBe('ELITE')
      expect(getStars(scoreMax)).toBe('★★★★★')
    })

    it('calculates Wilder ATR correctly', () => {
      const bars = makeBars(30, 100)
      const atr = calculateATR(bars, 14)
      expect(atr.length).toBe(30)
      // For bars with high=101, low=99, close=100, TR is always 2
      expect(atr[13]).toBeCloseTo(2.0, 4)
      expect(atr[29]).toBeCloseTo(2.0, 4)
    })
  })

  describe('Pivot Detection Core (5/5 Confirmed Swings)', () => {
    it('detects a confirmed swing high at the right bar with confirmation delay', () => {
      // 30 bars with a clear peak at index 10 (high = 120, others <= 100)
      const bars = makeBars(30, 100)
      bars[10] = {
        open: 100,
        high: 120, // peak
        low: 98,
        close: 102,
        timestamp: 10 * 300_000,
      }

      const res = calculateMtfSR(bars, {
        pivotLeft: 5,
        pivotRight: 5,
        simulatedBuckets: [1], // single timeframe on base bars
        timeframes: ['5'],
      })

      // Peak at index 10 requires 5 right bars to confirm => confirmed at bar 15
      expect(res.resistance.length).toBeGreaterThanOrEqual(1)
      const peakZone = res.resistance.find(z => z.level === 120)
      expect(peakZone).toBeDefined()
      expect(peakZone!.level).toBe(120)
      expect(peakZone!.isRes).toBe(true)
      expect(peakZone!.startBar).toBe(15) // confirmed at index 10 + 5

      // Rejection wick: high (120) - max(open:100, close:102) = 18
      expect(peakZone!.wickAvg).toBe(18)
    })

    it('detects a confirmed swing low at the right bar with lower rejection wick', () => {
      const bars = makeBars(30, 100)
      bars[12] = {
        open: 100,
        high: 102,
        low: 75, // trough
        close: 95,
        timestamp: 12 * 300_000,
      }

      const res = calculateMtfSR(bars, {
        pivotLeft: 5,
        pivotRight: 5,
        simulatedBuckets: [1],
        timeframes: ['5'],
      })

      expect(res.support.length).toBeGreaterThanOrEqual(1)
      const troughZone = res.support.find(z => z.level === 75)
      expect(troughZone).toBeDefined()
      expect(troughZone!.isRes).toBe(false)
      expect(troughZone!.startBar).toBe(17) // 12 + 5

      // Lower wick: min(open:100, close:95) - low:75 = 20
      expect(troughZone!.wickAvg).toBe(20)
    })
  })

  describe('Confluence Merge Algorithm', () => {
    it('merges overlapping levels across timeframes into a single confluence zone', () => {
      // Create a scenario where two simulated timeframes create pivots near the same price
      // Base candles have two nearby highs that close within ATR merge distance
      const bars = makeBars(50, 100)

      // Peak on TF 1 and TF 2 near price 115
      bars[10] = { open: 100, high: 115.0, low: 98, close: 101, timestamp: 10 * 300_000 }
      bars[22] = { open: 100, high: 115.4, low: 98, close: 101, timestamp: 22 * 300_000 }

      const mergedRes = calculateMtfSR(bars, {
        pivotLeft: 3,
        pivotRight: 3,
        simulatedBuckets: [1, 2], // 2 simulated timeframe slots
        timeframes: ['5', '10'],
        mergeEnabled: true,
        mergeAtrMultiple: 0.5,
      })

      const unmergedRes = calculateMtfSR(bars, {
        pivotLeft: 3,
        pivotRight: 3,
        simulatedBuckets: [1, 2],
        timeframes: ['5', '10'],
        mergeEnabled: false,
      })

      // With merge enabled, overlapping zones should fuse into confluence
      expect(mergedRes.confluence.length).toBeGreaterThanOrEqual(1)
      const confZone = mergedRes.confluence[0]!
      expect(confZone.confluenceCount).toBeGreaterThanOrEqual(2)
      // Level should be a weighted combination
      expect(confZone.level).toBeGreaterThan(114.5)
      expect(confZone.level).toBeLessThan(116.0)

      // Unmerged has more separate zones
      expect(unmergedRes.allZones.length).toBeGreaterThan(mergedRes.allZones.length)
    })
  })

  describe('Deterministic Execution & Edge Cases', () => {
    it('handles empty candle array gracefully', () => {
      const res = calculateMtfSR([])
      expect(res.resistance).toEqual([])
      expect(res.support).toEqual([])
      expect(res.confluence).toEqual([])
      expect(res.series).toEqual([])
      expect(res.dashboard.activeCount).toBe(0)
    })

    it('runs deterministically producing byte-for-byte identical output on repeated runs', () => {
      const bars = makeBars(60, 250)
      bars[15] = { open: 250, high: 270, low: 248, close: 252, timestamp: 15 * 300_000 }
      bars[35] = { open: 250, high: 252, low: 230, close: 248, timestamp: 35 * 300_000 }

      const run1 = calculateMtfSR(bars)
      const run2 = calculateMtfSR(bars)

      expect(JSON.stringify(run1)).toBe(JSON.stringify(run2))
    })

    it('produces per-bar series for klinecharts with res, sup, confluence', () => {
      const bars = makeBars(40, 100)
      bars[10] = { open: 100, high: 115, low: 98, close: 101, timestamp: 10 * 300_000 }
      bars[20] = { open: 100, high: 102, low: 85, close: 99, timestamp: 20 * 300_000 }

      const res = calculateMtfSR(bars, { pivotLeft: 3, pivotRight: 3, simulatedBuckets: [1] })
      expect(res.series.length).toBe(40)

      // Before confirmation (bars 0..12), no resistance yet
      expect(res.series[5]?.res).toBeUndefined()
      // After confirmation at bar 13, res is active
      expect(res.series[15]?.res).toBe(115)
    })
  })

  describe('Klinecharts Indicator Integration', () => {
    it('defines mtfSRIndicator with required figures and styles', () => {
      expect(mtfSRIndicator.name).toBe('MTF_SR')
      expect(mtfSRIndicator.series).toBe('price')
      expect(mtfSRIndicator.figures).toEqual([
        { key: 'res', type: 'line' },
        { key: 'sup', type: 'line' },
        { key: 'confluence', type: 'line' },
      ])
    })

    it('calculates series via mtfSRIndicator.calc', () => {
      const bars = makeBars(30, 50)
      const out = mtfSRIndicator.calc(bars, { calcParams: [3, 3, 0.35] })
      expect(Array.isArray(out)).toBe(true)
      expect(out.length).toBe(30)
    })

    it('provides tooltips via createTooltipDataSource', () => {
      const result = [{ res: 105.5, sup: 95.2, confluence: 100.0 }]
      const ds = mtfSRIndicator.createTooltipDataSource({
        indicator: { calcParams: [5, 5, 0.35], result },
        crosshair: { dataIndex: 0 },
      })
      expect(ds.values.length).toBe(3)
      expect(ds.values[0]!.title).toContain('阻力')
      expect(ds.values[0]!.value.text).toBe('105.50')
      expect(ds.values[1]!.title).toContain('支撑')
      expect(ds.values[1]!.value.text).toBe('95.20')
      expect(ds.values[2]!.title).toContain('共振带')
      expect(ds.values[2]!.value.text).toBe('100.00')
    })

    it('maintains compatibility with legacy mtfSRZones function', () => {
      const bars = makeBars(25, 100)
      const out = mtfSRZones(bars, 5)
      expect(Array.isArray(out)).toBe(true)
      expect(out.length).toBe(25)
    })
  })
})
