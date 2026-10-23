import { describe, expect, it } from 'vitest'
import { TD_DEFAULTS, aicoinTdIndicator, aicoinTdMarksIndicator, calculateAicoinTd, drawTdMarks, sanitizeTdParams, tdAlertEvents, tdWantsMarks, tdWantsPane } from '../src/client/indicators/aicoin-td.js'
import { EDITABLE, sanitizeSettings } from '../src/client/ChartCard.js'

const rows = (closes: number[]) => calculateAicoinTd(closes.map(close => ({ close })))

describe('AiCoin TD — oup/odn by hand', () => {
  const closes = [10, 11, 12, 13, 14, 15, 16, 15, 14, 13, 12, 11, 10, 10]
  //            i: 0   1   2   3   4   5   6   7   8   9  10  11  12  13
  // close>close[4]: i4 14>10, i5 15>11, i6 16>12, i7 15>13 → oup 1,2,3,4; i8 14>14 no → 0
  // close<close[4]: i9 13<15, i10 12<16, i11 11<15, i12 10<14, i13 10<13 → odn -1..-5
  it('UP counts consecutive close>close[4]; nan (gap) where oup == 0', () => {
    expect(rows(closes).map(r => r.up)).toEqual([undefined, undefined, undefined, undefined, 1, 2, 3, 4, undefined, undefined, undefined, undefined, undefined, undefined])
  })
  it('Down counts consecutive close<close[4] as positive numbers', () => {
    expect(rows(closes).map(r => r.dn)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 1, 2, 3, 4, 5])
    expect(rows(closes).map(r => r.odn).slice(8)).toEqual([0, -1, -2, -3, -4, -5])
  })
  it('first 4 bars: close[4] is nan → both counts 0', () => {
    expect(rows([5, 1, 9, 2]).map(r => [r.oup, r.odn])).toEqual([[0, 0], [0, 0], [0, 0], [0, 0]])
  })
  it('no clamp at 9 (the source has none): 15 rising closes reach 11', () => {
    const r = rows(Array.from({ length: 15 }, (_, i) => 100 + i))
    expect(r[14]!.up).toBe(11)
  })
  it('equal close resets both counts', () => {
    const r = rows([1, 2, 3, 4, 5, 6, 3])
    expect([r[5]!.oup, r[6]!.oup, r[6]!.odn]).toEqual([2, 0, 0])
  })
})

describe('AiCoin TD — plot styling / display', () => {
  it('defaults: source plot colours (AiCoin plot default white, linewidth 1); plugin slots appended', () => {
    expect(TD_DEFAULTS).toEqual([1, 0xffffff, 1, 1, 0xffffff, 1, 0, 1, 1, 1, 0, 0])
    expect(sanitizeTdParams([])).toEqual({
      showUp: true, upColor: 0xffffff, upWidth: 1, showDn: true, dnColor: 0xffffff, dnWidth: 1,
      mode: 0, theme: true, start: 1, highlight: true, alert9: false, alert13: false,
    })
  })
  it('figure styles: panel colours when theme is off, chart colours when on', () => {
    const [up, dn] = aicoinTdIndicator.figures
    const off = { calcParams: [1, 0x00ff00, 2, 1, 0xff0000, 3, 1, 0] }
    expect(up!.styles(null, off)).toEqual({ color: '#00ff00', size: 2 })
    expect(dn!.styles(null, off)).toEqual({ color: '#ff0000', size: 3 })
    const on = { calcParams: [1, 0x00ff00, 2, 1, 0xff0000, 3, 1, 1], extendData: { up: '#3ddc97', down: '#f47067' } }
    expect(up!.styles(null, on)).toEqual({ color: '#3ddc97', size: 2 })
    expect(dn!.styles(null, on)).toEqual({ color: '#f47067', size: 3 })
  })
  it('display off blanks that plot only', () => {
    const data = [10, 11, 12, 13, 14].map(close => ({ close }))
    expect(aicoinTdIndicator.calc(data, { calcParams: [0, 0xffffff, 1, 1, 0xffffff, 1] })[4]).toEqual({ up: undefined, dn: undefined })
    expect(aicoinTdIndicator.calc(data, { calcParams: [...TD_DEFAULTS] })[4]).toEqual({ up: 1, dn: undefined })
  })
  it('显示方式 decides which parts mount', () => {
    const at = (mode: number) => { const p = [...TD_DEFAULTS]; p[6] = mode; return [tdWantsMarks(p), tdWantsPane(p)] }
    expect([at(0), at(1), at(2)]).toEqual([[true, false], [false, true], [true, true]])
  })
  it('EDITABLE: pane def with params 1:1 to defaults', () => {
    const def = EDITABLE.find(d => d.name === 'AICOIN_TD')!
    expect(def.pane).toBe('pane_aicoin_td')
    expect(def.params).toHaveLength(TD_DEFAULTS.length)
    const p = [1, 0x00ff00, 2, 0, 0xff0000, 1, 2, 0, 5, 0, 1, 1]
    expect(sanitizeSettings({ AICOIN_TD: { params: p, visible: true } })['AICOIN_TD']).toEqual({ params: p, visible: true })
  })
})

describe('AiCoin TD — numbers on the candles', () => {
  function run(closes: number[], params: number[], barSpace = 10) {
    const texts: { text: string; color: string; y: number; font: string; alpha: number }[] = []
    const ctx = {
      font: '', textAlign: '', textBaseline: '', fillStyle: '', globalAlpha: 1, save() {}, restore() {},
      fillText(this: { fillStyle: string; font: string; globalAlpha: number }, text: string, _x: number, y: number) { texts.push({ text, color: this.fillStyle, y, font: this.font, alpha: this.globalAlpha }) },
    }
    const k = closes.map(c => ({ high: c + 1, low: c - 1, close: c }))
    drawTdMarks({
      ctx: ctx as never,
      indicator: { calcParams: params, result: calculateAicoinTd(k), extendData: { up: '#3ddc97', down: '#f47067' } },
      xAxis: { convertToPixel: i => i * 10 }, yAxis: { convertToPixel: v => 1000 - v },
      visibleRange: { from: 0, to: k.length }, barSpace: { bar: barSpace }, kLineDataList: k,
    })
    return texts
  }
  const rising = Array.from({ length: 15 }, (_, i) => 100 + i) // up counts 1..11 on bars 4..14
  it('UP above the high in the chart up colour; last bar translucent; 9 bold', () => {
    const t = run(rising, [...TD_DEFAULTS])
    expect(t.map(x => x.text)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'])
    expect(t.every(x => x.color === '#3ddc97')).toBe(true)
    expect(t[0]!.y).toBe(1000 - 105 - 2)
    expect(t[8]!.font.startsWith('bold 12px')).toBe(true)
    expect(t[10]!.alpha).toBe(0.5)
  })
  it('数字起始 hides the early counts; dense bars keep only 9 / 13', () => {
    const p = [...TD_DEFAULTS]; p[8] = 7
    expect(run(rising, p).map(x => x.text)).toEqual(['7', '8', '9', '10', '11'])
    expect(run(rising, [...TD_DEFAULTS], 4).map(x => x.text)).toEqual(['9'])
  })
  it('Down below the low', () => {
    const falling = Array.from({ length: 8 }, (_, i) => 100 - i)
    const t = run(falling, [...TD_DEFAULTS])
    expect(t.map(x => x.text)).toEqual(['1', '2', '3', '4'])
    expect(t[0]!.color).toBe('#f47067')
    expect(t[0]!.y).toBe(1000 - (96 - 1) + 2)
  })
  it('marks indicator is a price-pane overlay without figures', () => {
    expect(aicoinTdMarksIndicator.series).toBe('price')
    expect(aicoinTdMarksIndicator.figures).toEqual([])
  })
})

describe('AiCoin TD — 9 / 13 alerts (plugin addition, off by default)', () => {
  const candles = Array.from({ length: 15 }, (_, i) => ({ time: 't' + i, close: 100 + i }))
  // closed bar = index 13 → up count 10; index 12 → 9
  it('silent by default', () => {
    expect(tdAlertEvents(candles, TD_DEFAULTS)).toEqual([])
  })
  it('fires when the closed bar count equals 9', () => {
    const p = [...TD_DEFAULTS]; p[10] = 1
    expect(tdAlertEvents(candles.slice(0, 14), p).map(e => e.id)).toEqual(['t12|td.up9'])
    expect(tdAlertEvents(candles, p)).toEqual([])
  })
})
