import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_AXIS_SETTINGS,
  sanitizeAxisSettings,
  toYAxisType,
  getAxisSettings,
  setAxisSettings,
  subscribeAxisSettings,
  getCandleYAxis,
  resetCandleYAxisAuto,
} from '../src/client/ChartCard.js'

describe('AxisSettings', () => {
  it('provides sensible default settings', () => {
    expect(DEFAULT_AXIS_SETTINGS).toEqual({
      coordType: 'normal',
      autoScale: {
        candle: true,
        rsi: true,
        accLs: true,
        macd: true,
      },
    })
  })

  it('sanitizes empty or corrupted input cleanly', () => {
    expect(sanitizeAxisSettings(null)).toEqual(DEFAULT_AXIS_SETTINGS)
    expect(sanitizeAxisSettings(undefined)).toEqual(DEFAULT_AXIS_SETTINGS)
    expect(sanitizeAxisSettings('invalid')).toEqual(DEFAULT_AXIS_SETTINGS)
    expect(sanitizeAxisSettings({ coordType: 'unknown' })).toEqual(DEFAULT_AXIS_SETTINGS)
  })

  it('preserves valid percentage and log coordinate types', () => {
    const pct = sanitizeAxisSettings({ coordType: 'percentage' })
    expect(pct.coordType).toBe('percentage')
    expect(pct.autoScale.candle).toBe(true)

    const log = sanitizeAxisSettings({ coordType: 'log' })
    expect(log.coordType).toBe('log')
  })

  it('sanitizes autoScale booleans faithfully', () => {
    const customized = sanitizeAxisSettings({
      coordType: 'log',
      autoScale: {
        candle: false,
        rsi: false,
        accLs: true,
        macd: false,
      },
    })
    expect(customized).toEqual({
      coordType: 'log',
      autoScale: {
        candle: false,
        rsi: false,
        accLs: true,
        macd: false,
      },
    })
  })

  it('maps CoordType to klinecharts 10 y-axis template names', () => {
    expect(toYAxisType('normal')).toBe('normal')
    expect(toYAxisType('percentage')).toBe('percentage')
    expect(toYAxisType('log')).toBe('logarithm')
  })

  it('notifies listeners when axis settings change', () => {
    let notified = 0
    const unsub = subscribeAxisSettings(() => { notified++ })
    setAxisSettings({
      coordType: 'percentage',
      autoScale: { candle: true, rsi: false, accLs: true, macd: true },
    })
    expect(notified).toBe(1)
    expect(getAxisSettings().coordType).toBe('percentage')
    expect(getAxisSettings().autoScale.rsi).toBe(false)
    unsub()
  })

  it('handles getCandleYAxis and resetCandleYAxisAuto safely with null or chart mock', () => {
    expect(getCandleYAxis(null)).toBeNull()
    expect(() => resetCandleYAxisAuto(null)).not.toThrow()

    const mockYAxis = {
      setAutoCalcTickFlag: vi.fn(),
      getAutoCalcTickFlag: vi.fn().mockReturnValue(true),
      isInCandle: vi.fn().mockReturnValue(true),
    }
    // klinecharts 10 path: public getYAxes + updatePane
    const mockChartV10 = {
      getYAxes: vi.fn().mockReturnValue([mockYAxis]),
      updatePane: vi.fn(),
    }
    expect(getCandleYAxis(mockChartV10 as any)).toBe(mockYAxis)
    resetCandleYAxisAuto(mockChartV10 as any)
    expect(mockYAxis.setAutoCalcTickFlag).toHaveBeenCalledWith(true)
    expect(mockChartV10.updatePane).toHaveBeenCalledWith(0, 'candle_pane')

    // klinecharts 9 fallback: getDrawPaneById + getAxisComponent + adjustPaneViewport
    mockYAxis.setAutoCalcTickFlag.mockClear()
    const mockPane = {
      getAxisComponent: vi.fn().mockReturnValue(mockYAxis),
    }
    const mockChartV9 = {
      getDrawPaneById: vi.fn().mockImplementation((id: string) => (id === 'candle_pane' ? mockPane : null)),
      adjustPaneViewport: vi.fn(),
    }
    expect(getCandleYAxis(mockChartV9 as any)).toBe(mockYAxis)
    resetCandleYAxisAuto(mockChartV9 as any)
    expect(mockYAxis.setAutoCalcTickFlag).toHaveBeenCalledWith(true)
    expect(mockChartV9.adjustPaneViewport).toHaveBeenCalledWith(false, true, true, true, true)
  })
})
