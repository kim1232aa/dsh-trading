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
  mtfSourceTimeframeSeconds,
  mtfSRZones,
  parseTimeframeSeconds,
  resolveMtfTimeframes,
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
    it.each([['1m', 60], ['15m', 900], ['4h', 14400], ['1d', 86400], ['3d', 259200], ['1w', 604800]] as const)('parses native fixed source timeframe %s', (tf, seconds) => {
      expect(mtfSourceTimeframeSeconds(tf)).toBe(seconds)
    })

    it.each(['1M', '3M', 'M', 'D', '60', '0m', '-1h', '1.5h', '1s', 'bad'])('leaves unsupported source timeframe %s unknown', tf => {
      expect(mtfSourceTimeframeSeconds(tf)).toBeUndefined()
    })

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

  describe('MTF bucket finality', () => {
    const cases = ['timestamp', 'simulated', 'synthesized'].flatMap(mode => [false, true].map(mirror => ({ mode, mirror })))
    const unknownOptions = { pivotLeft: 1, pivotRight: 1, timeframes: ['10'], mergeEnabled: false }
    const options = { ...unknownOptions, sourceTimeframeSeconds: 300 }

    function fixture(highs: number[], mirror: boolean, mode = 'timestamp'): Candle[] {
      return highs.map((high, i) => {
        const bar: Candle = { open: high - 1, high, low: high - 2, close: high - 1 }
        if (mirror) {
          bar.open = 100 - bar.open!
          bar.close = 100 - bar.close
          bar.low = 100 - high
          bar.high = 100 - (high - 2)
        }
        if (mode !== 'synthesized') bar.timestamp = Date.UTC(2024, 0, 1) + i * 300_000
        return bar
      })
    }

    it.each(cases)('ignores the partial right-leg bucket ($mode, mirror=$mirror)', ({ mode, mirror }) => {
      const bars = fixture([10, 10, 20, 20, 10, 25], mirror, mode)
      const params = { ...options, ...(mode === 'simulated' ? { simulatedBuckets: [2] } : {}) }
      const prefix = calculateMtfSR(bars.slice(0, 5), params)
      const appended = calculateMtfSR(bars, params)
      const key = mirror ? 'sup' : 'res'
      expect(prefix.series[4]?.[key]).toBeUndefined()
      expect(prefix.allZones).toEqual([])
      expect(appended.series.slice(0, 5)).toEqual(prefix.series)
      expect(appended.allZones).toEqual([])
    })

    it.each(cases)('retains a complete final bucket without an extra source bar ($mode, mirror=$mirror)', ({ mode, mirror }) => {
      const bars = fixture([10, 10, 20, 20, 10, 10], mirror, mode)
      const params = { ...options, ...(mode === 'simulated' ? { simulatedBuckets: [2] } : {}) }
      const result = calculateMtfSR(bars, params)
      const key = mirror ? 'sup' : 'res'
      const level = mirror ? 80 : 20
      expect(result.series[4]?.[key]).toBeUndefined()
      expect(result.series[5]?.[key]).toBe(level)
      expect(result.allZones.find(zone => zone.level === level)?.startBar).toBe(5)
    })

    it.each(cases)('matches batch history at every closed source prefix ($mode, mirror=$mirror)', ({ mode, mirror }) => {
      const bars = fixture([10, 10, 20, 20, 10, 10, 30, 30, 10, 10, 18, 18, 10, 10], mirror, mode)
      const params = { ...options, ...(mode === 'simulated' ? { simulatedBuckets: [2] } : {}) }
      const batch = calculateMtfSR(bars, params)
      for (let count = 2; count <= bars.length; count++) {
        expect(calculateMtfSR(bars.slice(0, count), params).series).toEqual(batch.series.slice(0, count))
      }
    })

    it.each(cases)('excludes an explicitly forming source tail ($mode, mirror=$mirror)', ({ mode, mirror }) => {
      const bars = fixture([10, 10, 20, 20, 10, 10, 10], mirror, mode)
      const params = { ...options, ...(mode === 'simulated' ? { simulatedBuckets: [2] } : {}), lastBarClosed: false }
      const forming = calculateMtfSR(bars.slice(0, 6), params)
      const updatedTail = fixture([10, 10, 20, 20, 10, 25], mirror, mode)
      const next = calculateMtfSR(bars, params)
      const key = mirror ? 'sup' : 'res'
      expect(forming.allZones).toEqual([])
      expect(calculateMtfSR(updatedTail, params).allZones).toEqual([])
      expect(next.series.slice(0, 5)).toEqual(forming.series.slice(0, 5))
      expect(next.series[5]?.[key]).toBe(mirror ? 80 : 20)
      expect(calculateMtfSR(bars.slice(0, 6), { ...params, lastBarClosed: true }).series[5]?.[key]).toBe(mirror ? 80 : 20)
    })

    it.each([false, true])('does not infer source cadence from an initial gap (mirror=%s)', mirror => {
      const bars = fixture([10, 20, 10, 30], mirror)
      ;[0, 180, 195, 196].forEach((minute, i) => { bars[i]!.timestamp = minute * 60_000 })
      const params = { ...unknownOptions, timeframes: ['15'], minScore: 0, atrPeriod: 1 }
      const prefix = calculateMtfSR(bars.slice(0, 3), params)
      const appended = calculateMtfSR(bars, params)
      const key = mirror ? 'sup' : 'res'
      expect(prefix.series[2]?.[key]).toBeUndefined()
      expect(prefix.allZones).toEqual([])
      expect(appended.series.slice(0, 3)).toEqual(prefix.series)
      expect(appended.allZones).toEqual([])
    })

    it.each([false, true])('waits for a later bucket when source cadence is unknown (mirror=%s)', mirror => {
      const bars = fixture([10, 10, 20, 20, 10, 10, 10], mirror)
      const prefix = calculateMtfSR(bars.slice(0, 6), unknownOptions)
      const appended = calculateMtfSR(bars, unknownOptions)
      const key = mirror ? 'sup' : 'res'
      expect(prefix.allZones).toEqual([])
      expect(appended.series.slice(0, 6)).toEqual(prefix.series)
      expect(appended.series[6]?.[key]).toBe(mirror ? 80 : 20)
      expect(appended.allZones.find(zone => zone.level === (mirror ? 80 : 20))?.startBar).toBe(6)
    })

    it.each([false, true])('confirms an unknown-cadence gap on its first provable source row (mirror=%s)', mirror => {
      const bars = fixture([10, 20, 10, 10, 10], mirror)
      ;[0, 180, 195, 196, 210].forEach((minute, i) => { bars[i]!.timestamp = minute * 60_000 })
      const params = { ...unknownOptions, timeframes: ['15'], minScore: 0, atrPeriod: 1 }
      const prefix = calculateMtfSR(bars.slice(0, 4), params)
      const appended = calculateMtfSR(bars, params)
      const key = mirror ? 'sup' : 'res'
      expect(prefix.allZones).toEqual([])
      expect(appended.series.slice(0, 4)).toEqual(prefix.series)
      expect(appended.series[4]?.[key]).toBe(mirror ? 80 : 20)
      expect(appended.allZones.find(zone => zone.level === (mirror ? 80 : 20))?.startBar).toBe(4)
    })

    it.each([0, -300, NaN, Infinity])('treats unprovable source cadence %s as unknown', sourceTimeframeSeconds => {
      const bars = fixture([10, 10, 20, 20, 10, 10, 10], false)
      const params = { ...unknownOptions, sourceTimeframeSeconds }
      const prefix = calculateMtfSR(bars.slice(0, 6), params)
      const appended = calculateMtfSR(bars, params)
      expect(prefix.allZones).toEqual([])
      expect(appended.series.slice(0, 6)).toEqual(prefix.series)
      expect(appended.series[6]?.res).toBe(20)
    })

    it('does not manufacture a finer timeframe from coarser source OHLC', () => {
      const bars = fixture([10, 20, 10, 10], false)
      expect(calculateMtfSR(bars, { ...options, timeframes: ['1'] }).allZones).toEqual([])
    })

    it.each([false, true])('keeps gapped live indicator history stable without source cadence (mirror=%s)', mirror => {
      const bars = fixture([10, 20, 10, 30, 10], mirror)
      ;[0, 180, 210, 211, 212].forEach((minute, i) => { bars[i]!.timestamp = minute * 60_000 })
      const prefix = mtfSRIndicator.calc(bars.slice(0, 4), { calcParams: [1, 1, 0.35] })
      const appended = mtfSRIndicator.calc(bars, { calcParams: [1, 1, 0.35] })
      const key = mirror ? 'sup' : 'res'
      expect(prefix[2]?.[key]).toBeUndefined()
      expect(appended.slice(0, 3)).toEqual(prefix.slice(0, 3))
    })

    it.each([false, true])('confirms a gapped bucket when its closure becomes known (mirror=%s)', mirror => {
      const bars = fixture([10, 10, 20, 20, 10, 10, 10], mirror)
      bars[5]!.timestamp! += 600_000
      bars[6]!.timestamp! += 600_000
      const prefix = calculateMtfSR(bars.slice(0, 5), options)
      const closed = calculateMtfSR(bars.slice(0, 6), options)
      const batch = calculateMtfSR(bars, options)
      const key = mirror ? 'sup' : 'res'
      expect(closed.series.slice(0, 5)).toEqual(prefix.series)
      expect(closed.series[5]?.[key]).toBe(mirror ? 80 : 20)
      expect(closed.allZones.find(zone => zone.level === (mirror ? 80 : 20))?.startBar).toBe(5)
      expect(batch.series.slice(0, 6)).toEqual(closed.series)
    })

    it('keeps the live chart tail out of higher-timeframe pivot confirmation', () => {
      const highs = [...Array(6).fill(10), ...Array(6).fill(20), ...Array(8).fill(10)]
      const bars = fixture(highs, false)
      const ind = { calcParams: [1, 1, 0.35], extendData: { sourceTimeframeSeconds: 300 } }
      const forming = mtfSRIndicator.calc(bars.slice(0, 18), ind)
      const next = mtfSRIndicator.calc(bars.slice(0, 19), ind)
      expect(forming[17]?.res).toBeUndefined()
      expect(next[17]?.res).toBe(20)
      expect(next.slice(0, 17)).toEqual(forming.slice(0, 17))
      const unknown = mtfSRIndicator.calc(bars.slice(0, 19), { calcParams: ind.calcParams })
      const observedNext = mtfSRIndicator.calc(bars, { calcParams: ind.calcParams })
      expect(unknown[17]?.res).toBeUndefined()
      expect(observedNext.slice(0, 18)).toEqual(unknown.slice(0, 18))
      expect(observedNext[18]?.res).toBe(20)
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
      expect(ds.legends.length).toBe(3)
      expect(ds.legends[0]!.title).toContain('阻力')
      expect(ds.legends[0]!.value.text).toBe('105.50')
      expect(ds.legends[1]!.title).toContain('支撑')
      expect(ds.legends[1]!.value.text).toBe('95.20')
      expect(ds.legends[2]!.title).toContain('共振带')
      expect(ds.legends[2]!.value.text).toBe('100.00')
    })

    it.each([false, true])('does not synthesize fixed intraday zones from calendar-month candles (mirror=%s)', mirror => {
      const data: Candle[] = [10, 20, 10, 10, 10].map((high, i) => ({
        timestamp: Date.UTC(2024, i, 1), open: mirror ? 45 : 5, close: mirror ? 45 : 5,
        high: mirror ? 50 : high, low: mirror ? 50 - high : 0, volume: 100,
      }))
      const result = calculateMtfSR(data, { sourceTimeframe: '1M', timeframes: ['30', '60', '120', '240'],
        pivotLeft: 1, pivotRight: 1, mergeEnabled: false, minScore: 0, atrPeriod: 1 })
      expect(result.resistanceLevels).toEqual([])
      expect(result.supportLevels).toEqual([])
      const rows = mtfSRIndicator.calc(data, { calcParams: [1, 1, 0.35], extendData: { sourceTimeframe: '1M' } })
      expect(rows).toHaveLength(data.length)
      expect(rows.every(r => r.res === undefined && r.sup === undefined)).toBe(true)
    })

    it('auto-ladders default slots when chart TF is coarser than 30/60/120/240', () => {
      // Daily crypto charts: default intraday slots are all finer than 1d and used to
      // produce an empty series (no green/purple zones). Defaults must climb to D/W.
      const n = 120
      const bars: Candle[] = Array.from({ length: n }, (_, i) => {
        const wave = Math.sin(i / 8) * 8
        const base = 100 + wave
        return {
          open: base, close: base + 0.5, high: base + 3, low: base - 3,
          timestamp: Date.UTC(2024, 0, 1) + i * 86_400_000,
        }
      })
      // Put a clear swing high / low so pivots exist on the daily ladder.
      bars[40]!.high = 130
      bars[40]!.close = 125
      bars[80]!.low = 70
      bars[80]!.close = 75
      const emptyLegacy = calculateMtfSR(bars, {
        sourceTimeframe: '1d', sourceTimeframeSeconds: 86_400, lastBarClosed: false,
        timeframes: ['30', '60', '120', '240'], pivotLeft: 2, pivotRight: 2,
      })
      expect(emptyLegacy.series.every(s => s.res === undefined && s.sup === undefined)).toBe(true)

      const viaDefaults = calculateMtfSR(bars, {
        sourceTimeframe: '1d', sourceTimeframeSeconds: 86_400, lastBarClosed: false,
        pivotLeft: 2, pivotRight: 2,
      })
      const hits = viaDefaults.series.filter(s => s.res !== undefined || s.sup !== undefined).length
      expect(hits).toBeGreaterThan(0)

      const viaCalc = mtfSRIndicator.calc(bars, {
        calcParams: [2, 2, 0.35],
        extendData: { sourceTimeframe: '1d', sourceTimeframeSeconds: 86_400 },
      })
      expect(viaCalc.filter(s => s.res !== undefined || s.sup !== undefined).length).toBeGreaterThan(0)
    })

    it('resolveMtfTimeframes keeps explicit finer-only requests empty', () => {
      expect(resolveMtfTimeframes(['1'], 300)).toEqual([])
      expect(resolveMtfTimeframes(undefined, 86_400)).toEqual(['1d', '3d', '1W'])
      expect(resolveMtfTimeframes(undefined, 300)).toEqual(['30', '60', '120', '240'])
      expect(resolveMtfTimeframes(undefined, 3600)).toEqual(['60', '120', '240'])
    })

        it('maintains compatibility with legacy mtfSRZones function', () => {
      const bars = makeBars(25, 100)
      const out = mtfSRZones(bars, 5)
      expect(Array.isArray(out)).toBe(true)
      expect(out.length).toBe(25)
    })
  })
})
