import { describe, expect, it } from 'vitest'
import { futureGutterPx } from '../src/client/ChartCard.js'
import type { DrawPrimitive } from '../src/client/ChartCard.js'

const last = Date.parse('2026-11-02T15:30:00.000Z')
const bar = 30 * 60_000
const poly = (...times: string[]): DrawPrimitive =>
  ({ kind: 'polyline', points: times.map(time => ({ time, price: 1 })) })

describe('futureGutterPx — room for a projected script', () => {
  it('returns undefined when no path runs past the last candle', () => {
    expect(futureGutterPx([poly('2026-11-02T10:00:00.000Z', '2026-11-02T15:30:00.000Z')], last, bar, 8, 1200)).toBeUndefined()
    expect(futureGutterPx([{ kind: 'hline', price: 1 }], last, bar, 8, 1200)).toBeUndefined()
  })

  it('opens bars-ahead (+4 air) times bar space', () => {
    // 10 bars ahead + 4 = 14 bars at 8 px.
    expect(futureGutterPx([poly('2026-11-02T10:00:00.000Z', '2026-11-02T20:30:00.000Z')], last, bar, 8, 1200)).toBe(112)
  })

  it('caps the gutter at 45% of the pane and never goes below the 80 px default', () => {
    expect(futureGutterPx([poly('2026-11-02T10:00:00.000Z', '2026-11-04T16:00:00.000Z')], last, bar, 8, 1000)).toBe(450)
    expect(futureGutterPx([poly('2026-11-02T10:00:00.000Z', '2026-11-02T16:00:00.000Z')], last, bar, 8, 1000)).toBe(80)
  })

  it('ignores degenerate bar spacing', () => {
    expect(futureGutterPx([poly('2026-11-02T10:00:00.000Z', '2026-11-04T16:00:00.000Z')], last, 0, 8, 1000)).toBeUndefined()
  })
})
