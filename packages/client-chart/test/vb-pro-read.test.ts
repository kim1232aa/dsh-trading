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
    expect(def.params).toHaveLength(19)
    expect(def.defaults).toEqual(vbProReadIndicator.calcParams)
    const s = sanitizeSettings({ VB_PRO_READ: { params: [1, 30, 2, 1.5, 5, 3, 0.4, 14, 22.5, 0, 1], visible: true } })
    expect(s['VB_PRO_READ']).toEqual({ params: [1, 30, 2, 1.5, 5, 3, 0.8, 14, 22.5, 0, 1, 0x1B5E40, 0xC0412F, 0x8A8A8A, 0, 0, 0, 0, 0], visible: true })
  })
})

describe('VB Pro-Read parity additions', () => {
  const trend = (n: number, step: number): VbCandle[] => Array.from({ length: n }, (_, i) => {
    const c = 100 + i * step + (i % 3 === 0 ? 0.3 : -0.2)
    return { high: c + 0.5, low: c - 0.5, close: c }
  })
  it('defaults: Pine colors, alerts off, 19 params', async () => {
    const { VB_DEFAULTS, intToHex } = await import('../src/client/indicators/vb-pro-read.js')
    expect(VB_DEFAULTS).toHaveLength(19)
    expect(VB_DEFAULTS.slice(11, 14).map(intToHex)).toEqual(['#1B5E40', '#C0412F', '#8A8A8A'])
    expect(VB_DEFAULTS.slice(14)).toEqual([0, 0, 0, 0, 0])
    const p = sanitizeVbParams([])
    expect(p.colUp).toBe('#1B5E40'); expect(p.alertOn).toEqual([false, false, false, false, false])
    expect(sanitizeVbParams([0, 20, 2, 1.5, 5, 3, 0.8, 14, 20, 1, 1, 0xFF0000, -5, 'x']).colUp).toBe('#FF0000')
    expect(sanitizeVbParams([0, 20, 2, 1.5, 5, 3, 0.8, 14, 20, 1, 1, 0xFF0000, -5]).colDn).toBe('#C0412F')
  })
  it('old 11-param storage upgrades; colors/alerts sanitized', () => {
    const s = sanitizeSettings({ VB_PRO_READ: { visible: true, params: [2, 30, 2, 1.5, 5, 3, 0.8, 14, 20, 0, 1] } })
    expect(s['VB_PRO_READ']!.params).toHaveLength(19)
    expect(s['VB_PRO_READ']!.params[0]).toBe(2)
    expect(s['VB_PRO_READ']!.params[11]).toBe(0x1B5E40)
    const bad = sanitizeSettings({ VB_PRO_READ: { visible: true, params: [5, 30, 2, 1.5, 5, 3, 0.8, 14, 20, 0, 1, 0x1000000, 1.5, 3, 2] } })
    expect(bad['VB_PRO_READ']!.params[0]).toBe(0)
    expect(bad['VB_PRO_READ']!.params[11]).toBe(0x1B5E40)
    expect(bad['VB_PRO_READ']!.params[14]).toBe(0)
    const def = EDITABLE.find(d => d.name === 'VB_PRO_READ')! as { params: { kind?: string; options?: string[] }[] }
    expect(def.params[0]!.kind).toBe('select'); expect(def.params[0]!.options).toEqual(['布林', '肯特纳', '唐奇安'])
    expect(def.params.slice(9, 11).every(p => p.kind === 'bool')).toBe(true)
    expect(def.params.slice(11, 14).every(p => p.kind === 'color')).toBe(true)
    expect(def.params.slice(14).every(p => p.kind === 'bool')).toBe(true)
  })
  it('alertconditions match Pine definitions bar by bar', () => {
    const c = [...trend(40, 0), ...trend(40, 1.5).map(b => ({ ...b, high: b.high + 40, low: b.low + 40, close: b.close + 40 }))]
    const rows = calculateVbProRead(c, [0, 20, 2, 1.5, 5, 3, 0.8, 14, 20, 1, 1])
    rows.forEach((r, i) => {
      const prev = rows[i - 1]
      expect(r.alerts.includes('walkUpStart')).toBe(r.walkUp && !(prev?.walkUp ?? false))
      expect(r.alerts.includes('walkDnStart')).toBe(r.walkDn && !(prev?.walkDn ?? false))
      expect(r.alerts.includes('fireUp')).toBe(r.fireUp)
      expect(r.alerts.includes('fireDn')).toBe(r.fireDn)
      expect(r.alerts.includes('mr')).toBe(r.mrLong || r.mrShort)
    })
    expect(rows.some(r => r.alerts.includes('walkUpStart'))).toBe(true)
  })
  it('enabled alerts gated by toggles (default off)', async () => {
    const { enabledVbAlerts } = await import('../src/client/indicators/vb-pro-read.js')
    const row = { alerts: ['fireUp', 'mr'] } as never
    expect(enabledVbAlerts(row, [])).toEqual([])
    const on = [0, 20, 2, 1.5, 5, 3, 0.8, 14, 20, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1]
    expect(enabledVbAlerts(row, on).map(a => a.key)).toEqual(['fireUp', 'mr'])
  })
  it('vbAlertEvents uses the latest closed bar and stable ids', async () => {
    const { vbAlertEvents } = await import('../src/client/ChartCard.js')
    const c = [...trend(40, 0), ...trend(40, 1.5).map(b => ({ ...b, high: b.high + 40, low: b.low + 40, close: b.close + 40 }))]
      .map((b, i) => ({ ...b, time: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString() }))
    const rows = calculateVbProRead(c, [])
    const k = rows.findIndex(r => r.alerts.includes('walkUpStart'))
    const ev = vbAlertEvents(c.slice(0, k + 2), [0, 20, 2, 1.5, 5, 3, 0.8, 14, 20, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0])
    expect(ev.map(e => e.id)).toEqual([`${c[k]!.time}|walkUpStart`])
    expect(vbAlertEvents(c.slice(0, k + 1), [0, 20, 2, 1.5, 5, 3, 0.8, 14, 20, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0]).some(e => e.id.startsWith(c[k]!.time))).toBe(false)
  })
  it('tooltip: 上/中/下轨 + state with object titles; legend params exclude colors', () => {
    const rows = calculateVbProRead(trend(60, 1), [])
    const tt = vbProReadIndicator.createTooltipDataSource({ indicator: { calcParams: [...(VB_DEF())], result: rows }, crosshair: { dataIndex: 59 } })
    const texts = tt.values.map(v => v.title.text + v.value.text)
    expect(texts[0]).toMatch(/^上轨: /); expect(texts[1]).toMatch(/^中轨: /); expect(texts[2]).toMatch(/^下轨: /)
    expect(['走带上', '走带下', '中性']).toContain(texts[3])
    expect(tt.calcParamsText).toBe('(0, 20, 2, 1.5, 5, 3, 0.8, 14, 20, 1, 1)')
  })
  it('fold keeps VB legend (exempt)', async () => {
    const { FOLD_EXEMPT } = await import('../src/client/ChartCard.js')
    const { createMainPaneTooltipFold } = await import('../src/client/indicator-tooltip.js')
    expect(FOLD_EXEMPT.has('VB_PRO_READ')).toBe(true)
    const calls: string[] = []
    const orig = () => ({}) as never
    const chart = { getIndicatorByPaneId: () => new Map([['VB_PRO_READ', { createTooltipDataSource: orig }], ['WMA', { createTooltipDataSource: orig }]]), overrideIndicator: (o: { name: string }) => { calls.push(o.name); return true } }
    createMainPaneTooltipFold(chart as never, FOLD_EXEMPT)(true)
    expect(calls).toEqual(['WMA'])
  })
})
import { VB_DEFAULTS as VBD } from '../src/client/indicators/vb-pro-read.js'
function VB_DEF() { return VBD }
