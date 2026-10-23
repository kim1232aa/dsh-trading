import { describe, expect, it } from 'vitest'
import { TD_DEFAULTS, aicoinTdIndicator, calculateAicoinTd, sanitizeTdParams } from '../src/client/indicators/aicoin-td.js'
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
  it('defaults follow AiCoin plot defaults: white, linewidth 1, both shown', () => {
    expect(TD_DEFAULTS).toEqual([1, 0xffffff, 1, 1, 0xffffff, 1])
    expect(sanitizeTdParams([])).toEqual({ showUp: true, upColor: 0xffffff, upWidth: 1, showDn: true, dnColor: 0xffffff, dnWidth: 1 })
  })
  it('figure styles read colour and width from calcParams', () => {
    const ind = { calcParams: [1, 0x00ff00, 2, 1, 0xff0000, 3] }
    const [up, dn] = aicoinTdIndicator.figures
    expect(up!.styles(null, ind)).toEqual({ color: '#00ff00', size: 2 })
    expect(dn!.styles(null, ind)).toEqual({ color: '#ff0000', size: 3 })
  })
  it('display off blanks that plot only', () => {
    const data = [10, 11, 12, 13, 14].map(close => ({ close }))
    expect(aicoinTdIndicator.calc(data, { calcParams: [0, 0xffffff, 1, 1, 0xffffff, 1] })[4]).toEqual({ up: undefined, dn: undefined })
    expect(aicoinTdIndicator.calc(data, { calcParams: [...TD_DEFAULTS] })[4]).toEqual({ up: 1, dn: undefined })
  })
  it('EDITABLE: sub-pane with 6 params 1:1 to defaults', () => {
    const def = EDITABLE.find(d => d.name === 'AICOIN_TD')!
    expect(def.pane).toBe('pane_aicoin_td')
    expect(def.params).toHaveLength(TD_DEFAULTS.length)
    expect(sanitizeSettings({ AICOIN_TD: { params: [1, 0x00ff00, 2, 0, 0xff0000, 1], visible: true } })['AICOIN_TD'])
      .toEqual({ params: [1, 0x00ff00, 2, 0, 0xff0000, 1], visible: true })
  })
})
