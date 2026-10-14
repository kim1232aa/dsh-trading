import { describe, expect, it } from 'vitest'
import { contractOpenInterest, postureColor } from '../src/client/market-client.js'

describe('contractOpenInterest', () => {
  it('plots contracts, never the USD value that rises when price spikes', () => {
    expect(contractOpenInterest({ openInterest: 2_280_000 })).toBe(2_280_000)
    expect(contractOpenInterest({ openInterest: null })).toBeNull()
    expect(contractOpenInterest({})).toBeNull()
  })

  it('colors the four quadrant labels that the strip shows', () => {
    expect(postureColor('强多头').color).toBe('#3ddc97')
    expect(postureColor('强空头').color).toBe('#f47067')
    expect(postureColor('弱反弹 / 轧空').color).toBe('#d2a8ff')
    expect(postureColor('多头踩踏').color).toBe('#d2a8ff')
  })
})
