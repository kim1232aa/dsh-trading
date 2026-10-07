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

  it('maps CoordType to klinecharts YAxisType correctly', () => {
    expect(toYAxisType('normal')).toBe('normal')
    expect(toYAxisType('percentage')).toBe('percentage')
    expect(toYAxisType('log')).toBe('log')
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
    }
    const mockPane = {
      getAxisComponent: vi.fn().mockReturnValue(mockYAxis),
    }
    const mockChart = {
      getDrawPaneById: vi.fn().mockImplementation((id: string) => (id === 'candle_pane' ? mockPane : null)),
      adjustPaneViewport: vi.fn(),
    }

    const yAxis = getCandleYAxis(mockChart as any)
    expect(yAxis).toBe(mockYAxis)

    resetCandleYAxisAuto(mockChart as any)
    expect(mockYAxis.setAutoCalcTickFlag).toHaveBeenCalledWith(true)
    expect(mockChart.adjustPaneViewport).toHaveBeenCalledWith(false, true, true, true, true)
  })
})
