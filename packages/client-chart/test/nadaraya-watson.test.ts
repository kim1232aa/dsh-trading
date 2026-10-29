import { describe, expect, it } from 'vitest'
import {
  NW_DEFAULTS,
  calculateNadarayaWatson,
  calculateNwFromParams,
  createNadarayaWatsonTooltipDataSource,
  drawNadarayaWatson,
  kernelWeight,
  migrateNwParams,
  nadarayaWatsonIndicator,
  nadarayaWatsonTrend,
  nwAlertEvents,
  pineRgba,
  sanitizeNwParams,
  type KernelType,
} from '../src/client/indicators/nadaraya-watson.js'

/** calcParams with overrides by index (see NW_DEFAULTS layout). */
const P = (o: Record<number, number>): number[] => { const p = [...NW_DEFAULTS]; for (const [k, v] of Object.entries(o)) p[Number(k)] = v; return p }
const closes = (xs: number[]) => xs.map(c => ({ open: c, high: c, low: c, close: c }))

describe('kernel_weight (pine L67-84)', () => {
  it('matches the Pine formula for every kernel', () => {
    const h = 4
    const d = 2
    const u = d / h
    expect(kernelWeight(d, h, 'Gaussian')).toBeCloseTo(Math.exp(-(d * d) / (2 * h * h)), 12)
    expect(kernelWeight(d, h, 'Rational Quadratic', 3)).toBeCloseTo(Math.pow(1 + (d * d) / (2 * 3 * h * h), -3), 12)
    expect(kernelWeight(d, h, 'Epanechnikov')).toBeCloseTo(0.75 * (1 - u * u), 12)
    expect(kernelWeight(d, h, 'Triangular')).toBeCloseTo(1 - u, 12)
    expect(kernelWeight(d, h, 'Quartic')).toBeCloseTo((15 / 16) * (1 - u * u) ** 2, 12)
    expect(kernelWeight(d, h, 'Cosine')).toBeCloseTo((Math.PI / 4) * Math.cos(Math.PI * u / 2), 12)
  })
  it('compact kernels are 0 beyond |u| > 1, infinite-support ones are not; h <= 0 gives 0', () => {
    for (const k of ['Epanechnikov', 'Triangular', 'Quartic', 'Cosine'] as KernelType[]) expect(kernelWeight(5, 4, k)).toBe(0)
    expect(kernelWeight(5, 4, 'Gaussian')).toBeGreaterThan(0)
    expect(kernelWeight(5, 4, 'Rational Quadratic')).toBeGreaterThan(0)
    expect(kernelWeight(0, 0, 'Gaussian')).toBe(0)
  })
})

describe('nw_trend / residual / bands (pine L86-107)', () => {
  // lookback 2, bandwidth 1, h_mult 1 → h = 1; w = [1, e^-0.5, e^-2]
  const params = P({ 3: 2, 4: 1, 5: 1, 7: 1, 8: 2 })
  const rows = calculateNwFromParams(closes([10, 20, 30, 40]), params)
  const w = [1, Math.exp(-0.5), Math.exp(-2)]
  const sw = w[0]! + w[1]! + w[2]!

  it('is na while src[lookback] is na (bar_index < lookback)', () => {
    expect(rows[0]!.value).toBeUndefined()
    expect(rows[1]!.value).toBeUndefined()
    expect(rows[1]!.upperBand).toBeUndefined()
  })
  it('equals the hand-computed weighted average and kernel-weighted MAD bands', () => {
    const nw2 = (30 * w[0]! + 20 * w[1]! + 10 * w[2]!) / sw
    const res2 = (w[0]! * Math.abs(30 - nw2) + w[1]! * Math.abs(20 - nw2) + w[2]! * Math.abs(10 - nw2)) / sw
    expect(rows[2]!.value).toBeCloseTo(nw2, 10)
    expect(rows[2]!.residual).toBeCloseTo(res2, 10)
    expect(rows[2]!.upperBand).toBeCloseTo(nw2 + res2 * 2, 10)
    expect(rows[2]!.lowerBand).toBeCloseTo(nw2 - res2 * 2, 10)
    const nw3 = (40 * w[0]! + 30 * w[1]! + 20 * w[2]!) / sw
    expect(rows[3]!.value).toBeCloseTo(nw3, 10)
  })
  it('compact kernel residual only counts w > 0 bars (L101)', () => {
    // Triangular, h = 2: w = [1, 0.5, 0]
    const r = calculateNwFromParams(closes([100, 20, 30]), P({ 2: 2, 3: 2, 4: 2, 5: 1 }))
    const nw = (30 * 1 + 20 * 0.5) / 1.5
    expect(r[2]!.value).toBeCloseTo(nw, 10)
    expect(r[2]!.residual).toBeCloseTo((Math.abs(30 - nw) + 0.5 * Math.abs(20 - nw)) / 1.5, 10)
  })
  it('band series plot only when Show Residual Bands is on (L145-146), but bands still exist for alerts', () => {
    const off = calculateNwFromParams(closes([10, 20, 30, 40]), P({ 3: 2, 4: 1, 5: 1, 7: 0 }))
    expect(off[3]!.upper).toBeUndefined()
    expect(off[3]!.upperBand).toBeDefined()
    expect(rows[3]!.upper).toBe(rows[3]!.upperBand)
  })
  it('source input (L32): hl2 / hlc3 / ohlc4 / hlcc4 / open', () => {
    const bars = [{ open: 1, high: 4, low: 0, close: 2 }, { open: 2, high: 6, low: 1, close: 3 }]
    const at = (src: number) => calculateNwFromParams(bars, P({ 1: src, 3: 1, 4: 1, 5: 1 }))[1]!.price
    expect(at(0)).toBe(3)
    expect(at(1)).toBe(2)
    expect(at(4)).toBe(3.5)
    expect(at(5)).toBeCloseTo(10 / 3, 12)
    expect(at(6)).toBe(3)
    expect(at(7)).toBe(3.25)
  })
})

describe('preset override (pine L51-53)', () => {
  it('Fast Response forces lookback 25 / bandwidth 5 / h_mult 1.5 regardless of the manual inputs', () => {
    const s = sanitizeNwParams(P({ 0: 1, 3: 3, 4: 40, 5: 9 }))
    expect([s.lookback, s.bandwidth, s.hMult]).toEqual([25, 5, 1.5])
    const r = calculateNwFromParams(closes(Array.from({ length: 30 }, (_, i) => 100 + i)), P({ 0: 1, 3: 3 }))
    expect(r[24]!.value).toBeUndefined()
    expect(r[25]!.value).toBeDefined()
  })
  it('Smooth Trend → 100 / 12 / 2.5, Default → manual inputs', () => {
    const s = sanitizeNwParams(P({ 0: 2 }))
    expect([s.lookback, s.bandwidth, s.hMult]).toEqual([100, 12, 2.5])
    const d = sanitizeNwParams(P({ 3: 7, 4: 3, 5: 1.2 }))
    expect([d.lookback, d.bandwidth, d.hMult]).toEqual([7, 3, 1.2])
  })
})

describe('reversals / colour / alerts (pine L109-116, L159-163)', () => {
  // lookback 1, Triangular h = 1 → w = [1, 0] → nw_trend == src from bar 1.
  const p = P({ 2: 2, 3: 1, 4: 1, 5: 1, 7: 1, 8: 1 })
  it('turned_bullish / turned_bearish need nw[1] < nw[2] and nw > nw[1] (and the mirror)', () => {
    const r = calculateNwFromParams(closes([0, 5, 4, 6, 7, 3]), p)
    expect(r.map(x => x.turnedBullish)).toEqual([false, false, false, true, false, false])
    expect(r.map(x => x.turnedBearish)).toEqual([false, false, false, false, false, true])
    expect(r[3]!.trendChanged).toBe(true)
  })
  it('trend colour is bullish on na / first bar, then nw > nw[1]', () => {
    const r = calculateNwFromParams(closes([0, 5, 4, 4, 6]), p)
    expect(r.map(x => x.isBullish)).toEqual([true, true, false, false, true])
  })
  it('band_cross_up/dn are ta.crossover/crossunder of src vs upper/lower', () => {
    // lookback 2, Gaussian h = 1; a jump far above the band then a fall far below.
    const q = P({ 3: 2, 4: 1, 5: 1, 8: 0.1 })
    const r = calculateNwFromParams(closes([10, 10, 10, 10, 50, 50, 55, -40]), q)
    expect(r[4]!.bandCrossUp).toBe(r[4]!.price > r[4]!.upperBand! && r[3]!.price <= r[3]!.upperBand!)
    expect(r[4]!.bandCrossUp).toBe(true)
    expect(r[7]!.bandCrossDn).toBe(r[7]!.price < r[7]!.lowerBand! && r[6]!.price >= r[6]!.lowerBand!)
    expect(r[7]!.bandCrossDn).toBe(true)
    expect(r[2]!.bandCrossUp).toBe(false) // first defined band bar: [1] is na
  })
  it('nwAlertEvents fires enabled alerts on the last closed bar only', () => {
    const bars = closes([0, 5, 4, 6, 99]).map((c, i) => ({ ...c, time: 'T' + i }))
    expect(nwAlertEvents(bars, p)).toEqual([])
    const on = [...p]; on[18] = 1; on[20] = 1
    expect(nwAlertEvents(bars, on).map(e => e.id)).toEqual(['T3|nw.turnedBullish', 'T3|nw.trendChanged'])
  })
})

describe('inputs / settings', () => {
  it('defaults are the Pine defaults in input order', () => {
    const s = sanitizeNwParams(NW_DEFAULTS)
    expect(s).toMatchObject({
      preset: 'Default', source: 'close', kernel: 'Gaussian', lookback: 50, bandwidth: 8, hMult: 2, relWeight: 8,
      showBands: false, bandMult: 1.5, showFill: true, showMarkers: true, colorPreset: 'Custom',
      bull: 0x00ffaa, bear: 0xff0000, showCandles: false, barTrans: 0, showBg: false, bgTrans: 90,
    })
    expect(nadarayaWatsonIndicator.calcParams).toEqual([...NW_DEFAULTS])
  })
  it('colour presets resolve like the Pine switch (L55-61)', () => {
    expect(sanitizeNwParams(P({ 11: 1 }))).toMatchObject({ bull: 0x00d4ff, bear: 0xff8c00 })
    expect(sanitizeNwParams(P({ 11: 4 }))).toMatchObject({ bull: 0xffff00, bear: 0xff00ff })
    expect(sanitizeNwParams(P({ 11: 5, 12: 0x123456 }))).toMatchObject({ bull: 0x123456, bear: 0xff0000 })
  })
  it('migrates the old 4-param layout [lookback, bandwidth, h_mult, band_mult]', () => {
    const m = migrateNwParams([30, 6, 1.5, 2.2])
    expect(m[3]).toBe(30); expect(m[4]).toBe(6); expect(m[5]).toBe(1.5); expect(m[8]).toBe(2.2)
    expect(m.length).toBe(NW_DEFAULTS.length)
    expect(migrateNwParams([...NW_DEFAULTS])).toEqual([...NW_DEFAULTS])
  })
  it('color.new transparency maps to alpha (100 - t) / 100', () => {
    expect(pineRgba(0x00ffaa, 60)).toBe('rgba(0, 255, 170, 0.4)')
    expect(pineRgba(0xff0000, 0)).toBe('rgba(255, 0, 0, 1)')
  })
  it('named-option wrappers agree with the calcParams path', () => {
    const bars = Array.from({ length: 70 }, (_, i) => ({ close: 100 + Math.sin(i / 6) * 10 }))
    const a = nadarayaWatsonTrend(bars, 30, 6, 2.0, 1.8)
    const b = calculateNadarayaWatson(bars, { lookback: 30, bandwidth: 6, multiplier: 2, bandMultiplier: 1.8 })
    const c = calculateNwFromParams(bars, P({ 3: 30, 4: 6, 5: 2, 7: 1, 8: 1.8 }))
    expect(a[60]!.value).toBeCloseTo(c[60]!.value!, 12)
    expect(b[60]!.upperBand).toBeCloseTo(c[60]!.upperBand!, 12)
  })
  it('tooltip shows NW Trend in trend colour and bands only when enabled', () => {
    const bars = closes([10, 20, 30, 40])
    const params = P({ 3: 2, 4: 1, 5: 1 })
    const result = calculateNwFromParams(bars, params)
    const t = createNadarayaWatsonTooltipDataSource({ indicator: { calcParams: params, result }, crosshair: { dataIndex: 3 } })
    expect(t.legends.map(v => v.title)).toEqual(['NW Trend: '])
    expect(t.legends[0]!.value.color).toBe('#00ffaa')
    const p2 = P({ 3: 2, 4: 1, 5: 1, 7: 1 })
    const t2 = createNadarayaWatsonTooltipDataSource({ indicator: { calcParams: p2, result: calculateNwFromParams(bars, p2) }, crosshair: { dataIndex: 3 } })
    expect(t2.legends.map(v => v.title)).toEqual(['NW Trend: ', 'NW Upper Band: ', 'NW Lower Band: '])
  })
})

describe('draw (pine L122-153)', () => {
  const recorder = () => {
    const fills: string[] = []
    const strokes: { style: string; width: number }[] = []
    const ctx = {
      fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: '', lineCap: '', globalCompositeOperation: 'source-over',
      save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
      fill() { fills.push(String(this.fillStyle)) }, fillRect() { fills.push('rect:' + String(this.fillStyle)) },
      stroke() { strokes.push({ style: String(this.strokeStyle), width: this.lineWidth }) },
    }
    return { ctx, fills, strokes }
  }
  const bars = closes([10, 20, 30, 40, 50, 60])
  const run = (params: number[]) => {
    const r = recorder()
    const ret = drawNadarayaWatson({
      ctx: r.ctx as never, indicator: { calcParams: params, result: calculateNwFromParams(bars, params) },
      xAxis: { convertToPixel: i => i * 10 }, yAxis: { convertToPixel: v => 100 - v },
      visibleRange: { from: 0, to: 5 }, bounding: { width: 60, height: 100 }, kLineDataList: bars,
    })
    return { ...r, ret }
  }
  it('default inputs: path linewidth 3 in bullish colour + 6 gradient fills, nothing else', () => {
    const { fills, strokes, ret } = run(P({ 3: 2, 4: 1, 5: 1 }))
    expect(ret).toBe(true)
    expect(strokes).toEqual([{ style: 'rgba(0, 255, 170, 1)', width: 3 }])
    expect(fills).toEqual([60, 68, 76, 84, 92, 96].map(t => 'rgba(0, 255, 170, ' + (100 - t) / 100 + ')'))
  })
  it('fill/markers off, bands/bar/bg colouring on', () => {
    const { fills, strokes } = run(P({ 3: 2, 4: 1, 5: 1, 7: 1, 9: 0, 10: 0, 14: 1, 16: 1 }))
    expect(fills[0]).toBe('rect:rgba(0, 255, 170, 0.1)') // bgcolor transp 90
    expect(fills).toContain('rgba(0, 255, 170, 0.1)') // residual band fill transp 90
    expect(strokes.filter(s => s.style === 'rgba(0, 255, 170, 0.45)')).toHaveLength(2) // bands transp 55
    expect(fills.filter(f => f === 'rect:rgba(0, 255, 170, 1)')).toHaveLength(4) // barcolor on bars 2..5
  })
})
