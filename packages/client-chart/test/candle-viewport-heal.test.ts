import { describe, expect, it, vi } from 'vitest'
import { planSubPaneHeight, healCandleViewport } from '../src/client/ChartCard.js'

describe('planSubPaneHeight', () => {
  it('keeps preferred height when there is room for the candle floor', () => {
    // 480 total, 200 candle min, 3 panes → budget 280 → 93 each, capped at preferred 72
    expect(planSubPaneHeight(480, 3, 200, 72)).toBe(72)
  })

  it('shrinks sub-panes when chrome leaves little room', () => {
    // 360 total, 200 candle, 4 panes → budget 160 → 40 each
    expect(planSubPaneHeight(360, 4, 200, 72)).toBe(40)
  })

  it('never goes below 40', () => {
    expect(planSubPaneHeight(220, 8, 200, 72)).toBe(40)
  })

  it('returns preferred when no sub-panes or unknown height', () => {
    expect(planSubPaneHeight(480, 0, 200, 72)).toBe(72)
    expect(planSubPaneHeight(0, 3, 200, 72)).toBe(72)
  })
})

describe('healCandleViewport', () => {
  it('resizes, redistributes sub-pane heights, and resets Y auto', () => {
    const setPaneOptions = vi.fn()
    const resize = vi.fn()
    const updatePane = vi.fn()
    const yAxis = {
      setAutoCalcTickFlag: vi.fn(),
      getAutoCalcTickFlag: vi.fn(() => true),
      isInCandle: () => true,
    }
    const chart = {
      getSize: () => ({ height: 400, width: 800 }),
      getPaneOptions: () => [
        { id: 'candle_pane' },
        { id: 'pane_vol' },
        { id: 'pane_rsi_grid' },
        { id: 'pane_rsi_cum' },
        { id: 'x_axis_pane' },
      ],
      setPaneOptions,
      resize,
      updatePane,
      getYAxes: () => [yAxis],
    }
    healCandleViewport(chart as never, true)
    // 400 - 200 candle = 200 budget / 3 subs = 66
    expect(setPaneOptions).toHaveBeenCalledWith({ id: 'pane_vol', height: 66 })
    expect(setPaneOptions).toHaveBeenCalledWith({ id: 'pane_rsi_grid', height: 66 })
    expect(setPaneOptions).toHaveBeenCalledWith({ id: 'pane_rsi_cum', height: 66 })
    expect(setPaneOptions).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'candle_pane' }))
    expect(setPaneOptions).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'x_axis_pane' }))
    expect(resize).toHaveBeenCalled()
    expect(yAxis.setAutoCalcTickFlag).toHaveBeenCalledWith(true)
  })

  it('no-ops on null', () => {
    expect(() => healCandleViewport(null)).not.toThrow()
  })
})
