import { describe, expect, it } from 'vitest'
import { rsiGridIndicator, rsiGridCumIndicator, rsiGridMarksIndicator, rsiGridRows } from '../src/client/indicators/rsi-grid.js'
import { rsiGrid } from '../../tool-market/src/rsi-grid.js'

const params = [7, 30, 60, 10]
const closes = [100, 101, 99, 102, 98, 103, 97, 104, 107, 110, 113, 116, 119, 122, 125,
  121, 117, 113, 109, 105, 101, 97, 93, 89, 85, 89, 94, 100, 107, 115, 123]
const bars = (values = closes) => values.map((close, i) => ({
  timestamp: Date.UTC(2024, 0, 1) + i * 60_000, open: values[Math.max(i - 1, 0)]!,
  high: Math.max(close, values[Math.max(i - 1, 0)]!) + 1,
  low: Math.min(close, values[Math.max(i - 1, 0)]!) - 1, close,
}))
function canvas() {
  const texts: string[] = []
  const noop = () => {}
  const ctx = new Proxy({ fillText: (s: string) => texts.push(s), measureText: (s: string) => ({ width: s.length * 6 }) },
    { get: (o, k) => Reflect.get(o, k) ?? noop, set: () => true }) as unknown as CanvasRenderingContext2D
  return { ctx, texts }
}
function drawMarks(list: ReturnType<typeof bars>, to = list.length) {
  const result = rsiGridRows(list, params)
  const { ctx, texts } = canvas()
  rsiGridMarksIndicator.draw({ ctx, indicator: { calcParams: params, result },
    xAxis: { convertToPixel: x => x * 10 }, yAxis: { convertToPixel: y => y },
    visibleRange: { from: 0, to }, bounding: { width: 768 }, kLineDataList: list })
  return texts
}

describe('RSI grid bearish coverage', () => {
  it('keeps the original long model and exposes the existing short model', () => {
    const list = bars()
    const rows = rsiGridRows(list, params)
    const long = rsiGrid(list, 7, 30, 60, 10, 'long', { closedOnly: true })
    const short = rsiGrid(list, 7, 40, 70, 10, 'short', { closedOnly: true })
    expect(short.bars.some(r => r.entry !== undefined)).toBe(true)
    expect(short.bars.some(r => r.exit !== undefined)).toBe(true)
    rows.forEach((r, i) => {
      expect(r.rsi).toBe(long.bars[i]!.rsi)
      expect(r.cum).toBe(long.bars[i]!.cum)
      expect(r.short).toMatchObject(short.bars[i]!)
      expect(r.shortCum).toBe(short.bars[i]!.cum === 0 ? 0 : -short.bars[i]!.cum)
    })
  })
  it('mirrors cumulative strength and fill timing when prices are reflected', () => {
    const up = rsiGridRows(bars(), params)
    const reflected = rsiGridRows(bars(closes.map(c => 300 - c)), params)
    up.forEach((r, i) => {
      expect(r.short.cum).toBeCloseTo(reflected[i]!.cum, 8)
      expect(r.short.signal).toBe(reflected[i]!.signal)
      expect(r.short.entry === undefined).toBe(reflected[i]!.entry === undefined)
      if (r.short.entry !== undefined) expect(r.short.entry).toBeCloseTo(300 - reflected[i]!.entry!, 8)
    })
  })
  it('gives the cumulative pane separate long/short curves and both axis thresholds', () => {
    const rows = rsiGridCumIndicator.calc(bars(), { calcParams: params })
    const keys = rsiGridCumIndicator.figures.map(f => f.key)
    expect(keys).toContain('cum')
    expect(keys).toContain('shortCum')
    expect(keys).toContain('longThreshold')
    expect(keys).toContain('shortThreshold')
    expect(rows.some(r => r.shortCum < 0)).toBe(true)
    expect(rows.every(r => r.longThreshold === 10 && r.shortThreshold === -10)).toBe(true)
    const { ctx, texts } = canvas()
    rsiGridCumIndicator.draw({ ctx, indicator: { calcParams: params, result: rows },
      xAxis: { convertToPixel: x => x }, yAxis: { convertToPixel: y => y },
      visibleRange: { from: 0, to: rows.length }, bounding: { width: 375 }, kLineDataList: bars() })
    expect(texts.join(' ')).toContain('多阈值10')
    expect(texts.join(' ')).toContain('空阈值-10')
  })
  it('draws short entries and short exits on their actual next-open fill bars', () => {
    const text = drawMarks(bars()).join(' ')
    expect(text).toContain('RSI空头')
    expect(text).toContain('平空')
    expect(text).toContain('RSI多头')
  })
  it('shows historical short position and signed PnL in the hovered tooltip', () => {
    const list = bars(), result = rsiGridRows(list, params)
    const i = result.findIndex(r => r.short?.inPos && r.short.posEntry !== undefined && list[result.indexOf(r)]!.close < r.short.posEntry)
    expect(i).toBeGreaterThan(-1)
    const tooltip = rsiGridIndicator.createTooltipDataSource({ indicator: { calcParams: params, result }, crosshair: { dataIndex: i }, kLineDataList: list })
    expect(tooltip.values.some(v => v.title.includes('持空') && v.value.text.includes('+'))).toBe(true)
    expect(tooltip.values.some(v => v.title.includes('空累计'))).toBe(true)
  })
  it('does not leak a future short cost line into an earlier viewport', () => {
    expect(drawMarks(bars(), 7).some(t => t.includes('持空') || t.includes('RSI空头'))).toBe(false)
  })
  it('keeps closed historical rows stable and suppresses fresh signals on the forming tail', () => {
    const list = bars()
    const before = rsiGridRows(list.slice(0, 20), params)
    expect(rsiGridRows(list, params).slice(0, 20)).toEqual(before)
    const period = 60_000, tailTime = Date.now() - 10_000
    const live = list.map((b, i) => ({ ...b, timestamp: tailTime - (list.length - 1 - i) * period }))
    const tail = rsiGridRows(live, params).at(-1)!
    expect(tail.provisional).toBe(true)
    expect(tail.short.provisional).toBe(true)
    expect(tail.signal).toBeUndefined()
    expect(tail.short.signal).toBeUndefined()
  })
})
