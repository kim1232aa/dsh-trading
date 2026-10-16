import { describe, expect, it } from 'vitest'
import { macdHistColor, macdHistStyles, SUBPLOT_COLORS as C } from '../src/client/ChartCard.js'

describe('MACD histogram colours', () => {
  it('4 shades: grow/fade above and below zero', () => {
    expect(macdHistColor(2, 1)).toBe(C.up)
    expect(macdHistColor(1, 2)).toBe(C.upFade)
    expect(macdHistColor(-2, -1)).toBe(C.down)
    expect(macdHistColor(-1, -2)).toBe(C.downFade)
    expect(macdHistColor(0.5, undefined)).toBe(C.up)
  })
  it('styles callback reads klinecharts indicatorData neighbours', () => {
    const s = macdHistStyles({ prev: { indicatorData: { hist: -3 } }, current: { indicatorData: { hist: -4 } } })
    expect(s.color).toBe(C.down)
  })
})
