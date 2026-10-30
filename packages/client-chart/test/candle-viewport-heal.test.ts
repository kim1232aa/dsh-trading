import { describe, expect, it, vi } from 'vitest'
import { planSubPaneHeight, healCandleViewport, resetCandleYAxisAuto } from '../src/client/ChartCard.js'

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

function mockChart(yAxis = {
  setAutoCalcTickFlag: vi.fn(),
  getAutoCalcTickFlag: vi.fn(() => true),
  isInCandle: () => true,
}) {
  const setPaneOptions = vi.fn()
  const resize = vi.fn()
  const updatePane = vi.fn()
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
  return { chart, setPaneOptions, resize, updatePane, yAxis }
}

describe('healCandleViewport', () => {
  it('sets Y auto BEFORE resize so klinecharts rebuilds range', () => {
    const { chart, setPaneOptions, resize, yAxis } = mockChart()
    const order: string[] = []
    yAxis.setAutoCalcTickFlag = vi.fn(() => { order.push('auto') })
    chart.resize = vi.fn(() => { order.push('resize') })
    healCandleViewport(chart as never, true)
    // 400 - 200 candle = 200 budget / 3 subs = 66
    expect(setPaneOptions).toHaveBeenCalledWith({ id: 'pane_vol', height: 66 })
    expect(setPaneOptions).toHaveBeenCalledWith({ id: 'pane_rsi_grid', height: 66 })
    expect(setPaneOptions).toHaveBeenCalledWith({ id: 'pane_rsi_cum', height: 66 })
    expect(setPaneOptions).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'candle_pane' }))
    expect(setPaneOptions).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'x_axis_pane' }))
    expect(order).toEqual(['auto', 'resize'])
    expect(yAxis.setAutoCalcTickFlag).toHaveBeenCalledWith(true)
  })

  it('skips Y auto when autoScaleCandle is false but still resizes panes', () => {
    const { chart, resize, yAxis } = mockChart()
    healCandleViewport(chart as never, false)
    expect(yAxis.setAutoCalcTickFlag).not.toHaveBeenCalled()
    expect(resize).toHaveBeenCalled()
  })

  it('no-ops on null', () => {
    expect(() => healCandleViewport(null)).not.toThrow()
  })
})

describe('resetCandleYAxisAuto', () => {
  it('sets autoCalc then resizes (not updatePane-only)', () => {
    const { chart, resize, updatePane, yAxis } = mockChart()
    const order: string[] = []
    yAxis.setAutoCalcTickFlag = vi.fn(() => { order.push('auto') })
    chart.resize = vi.fn(() => { order.push('resize') })
    resetCandleYAxisAuto(chart as never)
    expect(order).toEqual(['auto', 'resize'])
    expect(updatePane).not.toHaveBeenCalled()
  })
})
