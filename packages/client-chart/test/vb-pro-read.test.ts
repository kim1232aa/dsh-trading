import { describe, expect, it } from 'vitest'
import { adx, atr, calculateVbProRead, ema, sanitizeVbParams, sma, stdev, vbRuns, vbProReadIndicator, type VbCandle } from '../src/client/indicators/vb-pro-read.js'
import { EDITABLE, sanitizeSettings } from '../src/client/ChartCard.js'

const fx: VbCandle[] = [
  { high: 10, low: 8, close: 9 },
  { high: 11, low: 9, close: 10 },
  { high: 12, low: 9, close: 11 },
  { high: 11, low: 7, close: 8 },
  { high: 9, low: 6, close: 7 },
]

describe('VB primitives (Pine semantics)', () => {
  it('sma / biased stdev / sma-seeded ema', () => {
    const c = fx.map(b => b.close)
    expect(sma(c, 3)).toEqual([undefined, undefined, 10, 29 / 3, 26 / 3])
    expect(stdev(c, 3)[2]).toBeCloseTo(Math.sqrt(2 / 3), 12) // population, not n-1
    const e = ema(c, 3)
    expect(e[2]).toBe(10)
    expect(e[3]).toBeCloseTo(0.5 * 8 + 0.5 * 10, 12)
    expect(e[4]).toBeCloseTo(0.5 * 7 + 0.5 * 9, 12)
  })
  it('atr = rma(tr(true)) seeded with sma', () => {
    // TR: 2, 2, 3, 4, 3
    const a = atr(fx, 3)
    expect(a[1]).toBeUndefined()
    expect(a[2]).toBeCloseTo(7 / 3, 12)
    expect(a[3]).toBeCloseTo((7 / 3 * 2 + 4) / 3, 12)
  })
  it('adx (Wilder dmi) hand-computed, len=2', () => {
    // bar1: +DM1 -DM0 tr2; bar2: +DM1 -DM0 tr3; bar3: +0 -DM2 tr4; bar4: +0 -DM1 tr3
    // tr rma2: seed@2=(2+3)/2=2.5, @3=3.25, @4=3.125
    // +rma: @2=1, @3=.5, @4=.25 ; -rma: @2=0, @3=1, @4=1
    // dx@2 = 1 ; @3: p=.5/3.25,m=1/3.25 → |.5-1|/1.5=1/3 ; @4: .25 vs 1 → .75/1.25=.6
    // adx rma2 seed@3 = (1+1/3)/2 = 2/3 → 66.67 ; @4 = (2/3+.6)/2
    const a = adx(fx, 2)
    expect(a[2]).toBeUndefined()
    expect(a[3]).toBeCloseTo(200 / 3, 9)
    expect(a[4]).toBeCloseTo(100 * (2 / 3 + 0.6) / 2, 9)
  })
})

const ramp = (n: number, f: (i: number) => number, w = 0.5): VbCandle[] =>
  Array.from({ length: n }, (_, i) => ({ close: f(i), high: f(i) + w, low: f(i) - w }))

describe('VB states', () => {
  it('no look-ahead: rows for a prefix equal the full-series rows', () => {
    const bars = ramp(80, i => 100 + 10 * Math.sin(i / 5) + i * 0.3)
    const full = calculateVbProRead(bars)
    const pre = calculateVbProRead(bars.slice(0, 50))
    expect(pre).toEqual(full.slice(0, 50))
  })
  it('strong uptrend → walkUp, state 1', () => {
    const bars = ramp(60, i => 100 + i * 1.5 + (i % 2) * 0.2)
    const r = calculateVbProRead(bars).at(-1)!
    expect(r.adx!).toBeGreaterThan(20)
    expect(r.walkUp).toBe(true)
    expect(r.state).toBe(1)
  })
  it('strong downtrend → walkDn, state -1', () => {
    const r = calculateVbProRead(ramp(60, i => 300 - i * 1.5 + (i % 2) * 0.2)).at(-1)!
    expect(r.state).toBe(-1)
  })
  it('mean reversion short: close back below upper after closing above, no trend', () => {
    const bars = ramp(40, i => 100 + (i % 2 ? 1 : -1), 1)
    bars.push({ close: 106, high: 106.5, low: 104 }, { close: 101, high: 104, low: 100.5 })
    const rows = calculateVbProRead(bars, [0, 20, 2, 1.5, 5, 3, 0.8, 14, 99, 1, 1])
    const n = rows.length
    expect(bars[n - 2]!.close).toBeGreaterThan(rows[n - 2]!.upper!)
    expect(rows[n - 1]!.mrShort).toBe(true)
    expect(rows[n - 1]!.mrLong).toBe(false)
    // showMR=0 disables it
    expect(calculateVbProRead(bars, [0, 20, 2, 1.5, 5, 3, 0.8, 14, 99, 1, 0]).at(-1)!.mrShort).toBe(false)
  })
  it('squeeze on then fires upward on expansion', () => {
    // wide ranges (big ATR) with tight closes → BB inside KC
    const bars = ramp(40, i => 100 + (i % 2 ? 0.1 : -0.1), 3)
    const rows0 = calculateVbProRead(bars)
    expect(rows0.at(-1)!.sqz).toBe(true)
    bars.push({ close: 140, high: 140.5, low: 139.5 })
    const r = calculateVbProRead(bars).at(-1)!
    expect(r.sqz).toBe(false)
    expect(r.fireUp).toBe(true)
    expect(r.fireDn).toBe(false)
  })
  it('band type switch: BB / KC / Donchian', () => {
    const bars = ramp(30, i => 100 + i)
    const c = bars.map(b => b.close)
    const [bb, kc, dc] = [0, 1, 2].map(t => calculateVbProRead(bars, [t]).at(-1)!)
    expect(bb.basis).toBeCloseTo(sma(c, 20).at(-1)!, 9)
    expect(bb.upper! - bb.basis!).toBeCloseTo(2 * stdev(c, 20).at(-1)!, 9)
    expect(kc.basis).toBeCloseTo(ema(c, 20).at(-1)!, 9)
    expect(kc.upper! - kc.basis!).toBeCloseTo(1.5 * atr(bars, 20).at(-1)!, 9)
    expect(dc.upper).toBe(129.5)
    expect(dc.lower).toBe(109.5)
    expect(dc.basis).toBe(119.5)
    // squeeze independent of band type
    expect(bb.sqz).toBe(dc.sqz)
  })
  it('vbRuns merges consecutive same-state bars', () => {
    const rows = calculateVbProRead(ramp(60, i => 100 + i * 1.5))
    const runs = vbRuns(rows, 0, 59)
    expect(runs.length).toBeLessThan(10)
    expect(runs[0]!.start).toBe(19)
  })
})

describe('VB params', () => {
  it('sanitizes off-spec values to defaults', () => {
    const p = sanitizeVbParams([5, -1, NaN, 'x', 1, 0, 0.3, 14, 20, 2, 0])
    expect(p.bandType).toBe(0)
    expect(p.len).toBe(20)
    expect(p.bbMult).toBe(2)
    expect(p.kcMult).toBe(1.5)
    expect(p.walkN).toBe(5)
    expect(p.walkK).toBe(3)
    expect(p.outerPct).toBe(0.8)
    expect(p.showSqz).toBe(true)
    expect(p.showMR).toBe(false)
  })
  it('EDITABLE entry + settings sanitize', () => {
    const def = EDITABLE.find(d => d.name === 'VB_PRO_READ')!
    expect(def.title).toBe('波动带Pro-Read(Indicatr)')
    expect(def.defaultVisible).toBe(false)
    expect(def.pane).toBeUndefined()
    expect(def.params).toHaveLength(11)
    expect(def.defaults).toEqual(vbProReadIndicator.calcParams)
    const s = sanitizeSettings({ VB_PRO_READ: { params: [1, 30, 2, 1.5, 5, 3, 0.4, 14, 22.5, 0, 1], visible: true } })
    expect(s['VB_PRO_READ']).toEqual({ params: [1, 30, 2, 1.5, 5, 3, 0.8, 14, 22.5, 0, 1], visible: true })
  })
})
