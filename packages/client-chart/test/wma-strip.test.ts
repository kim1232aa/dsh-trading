import { describe, expect, it } from 'vitest'
import {
  evasiveSuperTrend,
  mtfSRZones,
  nadarayaWatsonTrend,
  orderBlockBreaker,
  sanitizeSettings,
  supertrend,
  wmaAt,
} from '../src/client/ChartCard.js'
import { DV_DEFAULTS } from '../src/client/indicators/dual-view-htf-patterns.js'
import { NW_DEFAULTS } from '../src/client/indicators/nadaraya-watson.js'
import { KP_DEFAULTS } from '../src/client/indicators/aicoin-kpattern.js'
import { TD_DEFAULTS } from '../src/client/indicators/aicoin-td.js'
import { REVPOINT_PARAM_DEFAULTS } from '../src/client/indicators/revpoint.js'

describe('supertrend', () => {
  // Independent reference: TradingView's published ta.supertrend pseudo-code, line by line.
  function reference(bars: { high: number; low: number; close: number }[], period: number, factor: number): (number | undefined)[] {
    const tr = bars.map((b, i) => i === 0 ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1]!.close), Math.abs(b.low - bars[i - 1]!.close)))
    const atr: (number | undefined)[] = []
    for (let i = 0; i < bars.length; i++) {
      atr.push(i < period - 1 ? undefined
        : i === period - 1 ? tr.slice(0, period).reduce((a, b) => a + b) / period
        : (atr[i - 1]! * (period - 1) + tr[i]!) / period)
    }
    const st: (number | undefined)[] = []
    let pl = 0, pu = 0, dir = NaN, prevSt: number | undefined
    bars.forEach((b, i) => {
      const a = atr[i]
      if (a === undefined) { st.push(undefined); return }
      const src = (b.high + b.low) / 2
      let lo = src - factor * a, up = src + factor * a
      const c1 = bars[i - 1]?.close ?? NaN
      lo = lo > pl || c1 < pl ? lo : pl
      up = up < pu || c1 > pu ? up : pu
      if (atr[i - 1] === undefined) dir = 1
      else if (prevSt === pu) dir = b.close > up ? -1 : 1
      else dir = b.close < lo ? 1 : -1
      prevSt = dir === -1 ? lo : up
      st.push(prevSt)
      pl = lo; pu = up
    })
    return st
  }

  it('matches the TradingView definition on a trending-then-reversing series', () => {
    const bars = Array.from({ length: 300 }, (_, i) => {
      const c = 100 + 20 * Math.sin(i / 25) + (i % 7) * 0.3
      return { high: c + 1 + (i % 3), low: c - 1 - (i % 5) * 0.4, close: c }
    })
    const rows = supertrend(bars, 10, 3)
    expect(rows.map(r => r.up ?? r.dn)).toEqual(reference(bars, 10, 3))
    const sides = rows.map(r => r.up !== undefined ? 'up' : r.dn !== undefined ? 'dn' : '-')
    expect(sides.slice(0, 9).every(s => s === '-')).toBe(true)
    expect(sides).toContain('up')
    expect(sides).toContain('dn')
  })
  it('survives flat bars (zero true range)', () => {
    const flat = Array.from({ length: 5 }, () => ({ high: 1, low: 1, close: 1 }))
    expect(supertrend(flat, 2, 3)[4]).toEqual({ dn: 1 })
  })
})

describe('sanitizeSettings', () => {
  it('defaults for absent or garbage input', () => {
    expect(sanitizeSettings(null)).toEqual({
      WMA: { params: [60, 100, 200], visible: true },
      SUPERTREND: { params: [60, 4], visible: true },
      EVASIVE_ST: { params: [10, 3.0, 1.0, 0.5], visible: false },
      NW_TREND: { params: [...NW_DEFAULTS], visible: false },
      OB_BB: { params: [5, 5, 20], visible: false },
      VB_PRO_READ: { params: [0, 20, 2.0, 1.5, 5, 3, 0.8, 14, 20, 1, 1, 0x1B5E40, 0xC0412F, 0x8A8A8A, 0, 0, 0, 0, 0], visible: false },
      DUAL_VIEW_HTF: { params: [...DV_DEFAULTS], visible: false },
      MTF_SR: { params: [5], visible: false },
      AICOIN_KPATTERN: { params: [...KP_DEFAULTS], visible: false },
      AICOIN_TD: { params: [...TD_DEFAULTS], visible: false },
      VOL_TIER: { params: [4], visible: true },
      OI_POSTURE: { params: [], visible: true },
      RSI_GRID: { params: [7, 30, 60, 10], visible: true },
      REVPOINT: { params: [...REVPOINT_PARAM_DEFAULTS], visible: true },
      ENTRY_SIGNAL: { params: [60, 4], visible: false },
      LARGE_WALLS: { params: [100, 20, 8], visible: false },
    })
    expect(sanitizeSettings('x')).toEqual(sanitizeSettings(null))
  })
  it('keeps valid fields, resets bad ones individually', () => {
    const s = sanitizeSettings({ WMA: { params: [20, 0, 1.5], visible: false }, SUPERTREND: { params: [10, 2.5] } })
    expect(s['WMA']).toEqual({ params: [20, 100, 200], visible: false })
    expect(s['SUPERTREND']).toEqual({ params: [10, 2.5], visible: true })
    expect(s['EVASIVE_ST']).toEqual({ params: [10, 3.0, 1.0, 0.5], visible: false })
    expect(s['NW_TREND']).toEqual({ params: [...NW_DEFAULTS], visible: false })
    // pre-1:1 4-param layout migrates into lookback/bandwidth/h_mult/band_mult slots
    const old = sanitizeSettings({ NW_TREND: { params: [30, 6, 1.5, 2.5], visible: true } })['NW_TREND']!
    expect([old.params[3], old.params[4], old.params[5], old.params[8], old.visible]).toEqual([30, 6, 1.5, 2.5, true])
    // legacy 9-param REVPOINT migrates into 28-param v6.5 defaults
    const oldRp = sanitizeSettings({ REVPOINT: { params: [0.9, 2.5, 4, 1, 0, 1, 0, 1, 2], visible: true } })['REVPOINT']!
    expect(oldRp.params.slice(0, 9)).toEqual([0.9, 2.5, 4, 1, 0, 1, 0, 1, 2])
    expect(oldRp.params.length).toBe(REVPOINT_PARAM_DEFAULTS.length)
    expect(s['OI_POSTURE']).toEqual({ params: [], visible: true })
    expect(s).not.toHaveProperty('LSR_RATIO')
  })
  it('discards a saved enabled LSR pane while keeping OI available', () => {
    const s = sanitizeSettings({ LSR_RATIO: { params: [], visible: true } })
    expect(s).not.toHaveProperty('LSR_RATIO')
    expect(s['OI_POSTURE']?.visible).toBe(true)
  })
  it('LARGE_WALLS defaults to 100万 and clamps out-of-range', () => {
    expect(sanitizeSettings(null)['LARGE_WALLS']).toEqual({ params: [100, 20, 8], visible: false })
    expect(sanitizeSettings({ LARGE_WALLS: { params: [500, 15, 6], visible: true } })['LARGE_WALLS'])
      .toEqual({ params: [500, 15, 6], visible: true })
    expect(sanitizeSettings({ LARGE_WALLS: { params: [9999, 20, 8], visible: true } })['LARGE_WALLS'])
      .toEqual({ params: [100, 20, 8], visible: true })
    expect(sanitizeSettings({ LARGE_WALLS: { params: [-1, 20, 8], visible: true } })['LARGE_WALLS'])
      .toEqual({ params: [100, 20, 8], visible: true })
  })
})

describe('ported indicators', () => {
  const bars = Array.from({ length: 60 }, (_, i) => ({
    high: 100 + i + (i % 4 === 0 ? 3 : 0),
    low: 98 + i - (i % 5 === 0 ? 3 : 0),
    close: 99 + i,
  }))

  it('evasiveSuperTrend runs and yields up/dn values', () => {
    const out = evasiveSuperTrend(bars, 10, 3.0, 1.0, 0.5)
    expect(out.length).toBe(60)
    expect(out[20]?.up).toBeDefined()
  })

  it('nadarayaWatsonTrend computes kernel smoothing and envelope bands', () => {
    const out = nadarayaWatsonTrend(bars, 20, 5, 2.0, 1.8)
    expect(out.length).toBe(60)
    expect(out[30]?.nw).toBeDefined()
    expect(out[30]?.upper).toBeGreaterThan(out[30]?.nw!)
    expect(out[30]?.lower).toBeLessThan(out[30]?.nw!)
  })

  it('orderBlockBreaker detects sweeps and structure breaks', () => {
    const out = orderBlockBreaker(bars)
    expect(out.length).toBe(60)
    expect(Array.isArray(out)).toBe(true)
  })

  it('mtfSRZones identifies pivot levels', () => {
    const out = mtfSRZones(bars, 5)
    expect(out.length).toBe(60)
    expect(Array.isArray(out)).toBe(true)
  })
})
import { formatCountdown, formatFunding } from '../src/client/ChartPanel.js'

describe('wmaAt', () => {
  it('weights the newest bar heaviest', () => {
    // (1·1 + 2·2 + 3·3) / 6
    expect(wmaAt([1, 2, 3], 2, 3)).toBeCloseTo(14 / 6)
  })
  it('is undefined until the window is full, and out of range', () => {
    expect(wmaAt([1, 2, 3], 1, 3)).toBeUndefined()
    expect(wmaAt([1, 2, 3], 3, 1)).toBeUndefined()
    expect(wmaAt([1, 2, 3], 0, 0)).toBeUndefined()
  })
  it('equals the price on a flat series', () => {
    expect(wmaAt(Array(200).fill(2716.25), 199, 200)).toBeCloseTo(2716.25)
  })
})

describe('derivatives strip formatting', () => {
  it('prints funding as signed percent, four decimals', () => {
    expect(formatFunding(0.00007774)).toBe('+0.0078%')
    expect(formatFunding(-0.00001617)).toBe('-0.0016%')
  })
  it('counts down to settlement and goes blank once past', () => {
    const now = Date.parse('2026-10-02T04:52:00Z')
    expect(formatCountdown('2026-10-02T08:00:00Z', now)).toBe('3h 08m')
    expect(formatCountdown('2026-10-02T04:00:00Z', now)).toBe('')
    expect(formatCountdown('garbage', now)).toBe('')
  })
})
