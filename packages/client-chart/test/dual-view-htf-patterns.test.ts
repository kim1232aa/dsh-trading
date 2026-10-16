import { describe, expect, it } from 'vitest'
import {
  aggregateHtf, attachHtfMa, calculateDualViewHtf, detectPatternAtIndex, DV_DEFAULTS,
  getTimeframeLabel, htfBucketStart, patternCandleCount, sanitizeDvParams, PATTERN_KEYS, HTF_TF_OPTIONS,
  type DvCandle,
} from '../src/client/indicators/dual-view-htf-patterns.js'
import { EDITABLE, sanitizeSettings } from '../src/client/ChartCard.js'

const bar = (o: number, h: number, l: number, c: number, ts: number): DvCandle =>
  ({ open: o, high: h, low: l, close: c, timestamp: ts })

describe('HTF aggregation', () => {
  it('buckets daily by UTC day boundary (timeframe.change style)', () => {
    const day = 86_400_000
    const t0 = Date.UTC(2024, 0, 1, 1)
    const candles = [
      bar(100, 105, 99, 104, t0),
      bar(104, 110, 103, 108, t0 + 3600_000),
      bar(108, 112, 100, 101, t0 + day), // next day
      bar(101, 103, 100, 102, t0 + day + 3600_000),
    ]
    const { completed, current } = aggregateHtf(candles, 'D')
    expect(completed).toHaveLength(1)
    expect(completed[0]!.open).toBe(100)
    expect(completed[0]!.high).toBe(110)
    expect(completed[0]!.low).toBe(99)
    expect(completed[0]!.close).toBe(108)
    expect(current!.open).toBe(108)
    expect(current!.close).toBe(102)
    expect(htfBucketStart(t0, 'D')).toBe(Date.UTC(2024, 0, 1))
  })

  it('aggregates 60m slots', () => {
    const t0 = Date.UTC(2024, 5, 1, 10, 5)
    const candles = [
      bar(1, 2, 0.5, 1.5, t0),
      bar(1.5, 3, 1.4, 2.5, t0 + 10 * 60_000),
      bar(2.5, 4, 2, 3.5, t0 + 60 * 60_000), // next hour
    ]
    const { completed, current } = aggregateHtf(candles, '60')
    expect(completed).toHaveLength(1)
    expect(completed[0]!.high).toBe(3)
    expect(current!.open).toBe(2.5)
  })
})

describe('pattern detectors (Pine parity)', () => {
  it('bullish engulfing after downtrend MA', () => {
    const t0 = Date.UTC(2024, 0, 1)
    const bars: DvCandle[] = []
    for (let i = 0; i < 15; i++) {
      const c = 200 - i * 2
      bars.push(bar(c + 1, c + 2, c - 1, c, t0 + i * 86_400_000))
    }
    bars.push(bar(171, 172, 168, 169, t0 + 15 * 86_400_000)) // bearish
    bars.push(bar(168, 175, 167, 174, t0 + 16 * 86_400_000)) // bullish engulf
    bars.push(bar(174, 175, 173, 174.5, t0 + 17 * 86_400_000)) // close the HTF so engulf is completed
    const done = aggregateHtf(bars, 'D').completed
    attachHtfMa(done, 'EMA', 12)
    const d = detectPatternAtIndex(done, 0, sanitizeDvParams())
    // newest completed is the stub day; pattern is on candle_index 1 (engulf pair)
    const dEngulf = detectPatternAtIndex(done, 1, sanitizeDvParams())
    expect(dEngulf.keys.length + d.keys.length).toBeGreaterThan(0)
    const hit = d.keys.includes('bullish_engulfing') || dEngulf.keys.includes('bullish_engulfing')
    expect(hit).toBe(true)
    expect(patternCandleCount('Bullish Engulfing')).toBe(2)
  })

  it('morning star after downtrend', () => {
    const t0 = Date.UTC(2024, 0, 1)
    const bars: DvCandle[] = []
    for (let i = 0; i < 14; i++) {
      const c = 200 - i * 3
      bars.push(bar(c + 2, c + 3, c - 1, c, t0 + i * 86_400_000))
    }
    // long bear, small indecision, strong bull into first body
    bars.push(bar(160, 161, 140, 141, t0 + 14 * 86_400_000)) // strong bear
    bars.push(bar(141.5, 142, 140.5, 141.2, t0 + 15 * 86_400_000)) // tiny
    bars.push(bar(142, 158, 141.5, 156, t0 + 16 * 86_400_000)) // strong bull past midpoint
    const { completed } = aggregateHtf(bars, 'D')
    // last bar may be forming — complete by taking completed + if current exists we need it completed
    // Aggregate all as completed: each day one bar so last is forming; push a next-day stub
    bars.push(bar(156, 157, 155, 156.5, t0 + 17 * 86_400_000))
    const ag = aggregateHtf(bars, 'D')
    const done = ag.completed
    attachHtfMa(done, 'EMA', 12)
    const d = detectPatternAtIndex(done, 0, sanitizeDvParams())
    expect(d.keys).toContain('morning_star')
    expect(patternCandleCount(d.text)).toBe(3)
  })

  it('harami off by default', () => {
    expect(sanitizeDvParams().show.bearish_harami).toBe(false)
    expect(sanitizeDvParams().show.bullish_harami).toBe(false)
    expect(sanitizeDvParams().show.hammer).toBe(true)
  })
})

describe('calculateDualViewHtf + EDITABLE wiring', () => {
  it('fills floating candles and no look-ahead on MA prefix', () => {
    const t0 = Date.UTC(2024, 0, 1)
    const bars: DvCandle[] = Array.from({ length: 40 }, (_, i) => {
      const c = 100 + Math.sin(i / 3) * 5 + i * 0.2
      return bar(c - 0.5, c + 1, c - 1, c, t0 + i * 86_400_000)
    })
    const full = calculateDualViewHtf(bars, DV_DEFAULTS)
    const pre = calculateDualViewHtf(bars.slice(0, 30), DV_DEFAULTS)
    // MA on shared prefix should match for completed HTF that fully exist in both
    expect(pre[20]?.ma).toBeDefined()
    expect(full[20]?.ma).toBeCloseTo(pre[20]!.ma!, 8)
    expect(full.at(-1)!.float!.length).toBe(7)
    expect(full.at(-1)!.htfLabel).toBe(getTimeframeLabel('D'))
  })

  it('EDITABLE DUAL_VIEW_HTF defaults length matches params', () => {
    const def = EDITABLE.find(d => d.name === 'DUAL_VIEW_HTF')!
    expect(def.defaults.length).toBe(def.params.length)
    expect(def.defaults.length).toBe(DV_DEFAULTS.length)
    expect(PATTERN_KEYS.length).toBe(19)
    const s = sanitizeSettings({})
    expect(s['DUAL_VIEW_HTF']!.visible).toBe(false)
    expect(s['DUAL_VIEW_HTF']!.params[0]).toBe(7) // Daily
    expect(s['DUAL_VIEW_HTF']!.params[43]).toBeCloseTo(0.05, 8) // doji exposed
  })

  it('HTF options cover Pine get_timeframe_label set; floating labels use center size default', () => {
    expect(HTF_TF_OPTIONS).toEqual(['60', '120', '180', '240', '360', '480', '720', 'D', 'W', 'M'])
    const P = sanitizeDvParams(DV_DEFAULTS)
    expect(P.htfTf).toBe('D')
    expect(P.centerSize).toBe(2) // normal — Pine floating pattern label size
    expect(P.textSize).toBe(1) // small — Pine historical pattern_text_size
  })
})
