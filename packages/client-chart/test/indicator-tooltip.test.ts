import { describe, expect, it, vi } from 'vitest'
import type { Chart, Indicator } from 'klinecharts'
import { klineStyles, seriesRows } from '../src/client/ChartCard.js'
import type { ChartTimeframeData } from '../src/client/payload.js'
import { createMainPaneTooltipFold } from '../src/client/indicator-tooltip.js'
import { rsiGridIndicator } from '../src/client/indicators/rsi-grid.js'
import { mockChart } from '../src/client/indicators/draw-context.js'

const palette = { bg: '#fff', text: '#333c45', faint: '#8b949e', line: '#e5e8eb', up: '#26a17b', down: '#e0563f' }

describe('subplot numerical legends', () => {
  it('keeps subplot names, parameters, and values visible without a crosshair', () => {
    const styles = klineStyles(palette) as { indicator: { tooltip: Record<string, unknown> }; candle: { tooltip: Record<string, unknown> } }
    expect(styles.indicator.tooltip).toMatchObject({
      showRule: 'always', showType: 'standard',
      title: { showName: true, showParams: true },
      legend: { defaultValue: '—' },
    })
    expect(styles.candle.tooltip.showType).toBe('rect')
  })

  it('preserves missing and non-finite payload values as gaps, while retaining real zero', () => {
    const data = {
      candles: Array.from({ length: 6 }, () => ({})),
      series: { macd_hist: [1.25, null, undefined, NaN, Infinity, 0] },
    } as unknown as ChartTimeframeData
    expect(seriesRows(data, { hist: 'macd_hist' })).toEqual([
      { hist: 1.25 }, { hist: undefined }, { hist: undefined },
      { hist: undefined }, { hist: undefined }, { hist: 0 },
    ])
  })

  it('shows the latest RSI normally and the hovered bar RSI on the crosshair', () => {
    const calcParams = [2, 30, 60, 10]
    const bars = [100, 101, 99, 102, 100].map((close) => ({ open: close, high: close + 1, low: close - 1, close }))
    const result = rsiGridIndicator.calc(bars, { calcParams })
    const tooltip = (dataIndex?: number) => rsiGridIndicator.createTooltipDataSource({
      chart: mockChart({ kLineDataList: bars }), indicator: { calcParams, result }, crosshair: { dataIndex },
    })
    expect(tooltip().legends[0]!.value.text).toBe(result.at(-1)!.rsi!.toFixed(2))
    expect(tooltip(2).legends[0]!.value.text).toBe(result[2]!.rsi!.toFixed(2))
    expect(tooltip(2).legends[0]!.value.text).not.toBe(tooltip().legends[0]!.value.text)
    expect(tooltip(0).legends[0]!.value.text).toBe('–')
  })
})

describe('main-chart tooltip folding', () => {
  function fixture() {
    const custom = vi.fn(() => ({ name: 'WMA', calcParamsText: '(60)', legends: [{ title: 'WMA60', value: '101.25' }], features: [] }))
    const main = [
      { name: 'WMA', createTooltipDataSource: custom },
      { name: 'TM_BB', createTooltipDataSource: null },
    ] as unknown as Indicator[]
    const overrideIndicator = vi.fn((override: { name: string; paneId?: string; createTooltipDataSource: Indicator['createTooltipDataSource'] }) => {
      const hit = main.find(i => i.name === override.name)
      if (hit) hit.createTooltipDataSource = override.createTooltipDataSource
      return true
    })
    const getIndicators = vi.fn((filter?: { paneId?: string }) => filter?.paneId === 'candle_pane' ? main : [])
    const chart = { getIndicators, overrideIndicator } as unknown as Pick<Chart, 'getIndicators' | 'overrideIndicator'>
    return { main, custom, overrideIndicator, getIndicators, fold: createMainPaneTooltipFold(chart) }
  }

  it('folds only candle-pane legends and preserves subplot callbacks', () => {
    const f = fixture()
    f.fold(true)
    for (const indicator of f.main) {
      expect(indicator.createTooltipDataSource!({} as never)).toEqual({ name: '', calcParamsText: '', legends: [], features: [] })
    }
    expect(f.overrideIndicator.mock.calls.every(([o]) => o.paneId === 'candle_pane')).toBe(true)
  })

  it('restores original custom legends and the library default after repeated folding', () => {
    const f = fixture()
    f.fold(true)
    f.fold(true)
    f.fold(false)
    expect(f.main.find(i => i.name === 'WMA')!.createTooltipDataSource).toBe(f.custom)
    expect(f.main.find(i => i.name === 'TM_BB')!.createTooltipDataSource).toBeNull()
    expect(f.custom().legends[0]!.value).toBe('101.25')
  })
})
