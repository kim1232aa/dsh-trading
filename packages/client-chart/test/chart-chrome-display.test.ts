import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DISPLAY,
  sanitizeDisplaySettings,
  displayStylesPatch,
  getDisplaySettings,
  setDisplaySettings,
  subscribeDisplaySettings,
} from '../src/client/ChartChrome.js'

describe('DisplaySettings (Pro chrome)', () => {
  it('defaults to Tokyo timezone and solid candles', () => {
    expect(DEFAULT_DISPLAY.timezone).toBe('Asia/Tokyo')
    expect(DEFAULT_DISPLAY.candleType).toBe('candle_solid')
    expect(DEFAULT_DISPLAY.gridShow).toBe(true)
  })

  it('sanitizes corrupt input', () => {
    expect(sanitizeDisplaySettings(null)).toEqual(DEFAULT_DISPLAY)
    expect(sanitizeDisplaySettings({ candleType: 'nope', timezone: '' })).toEqual(DEFAULT_DISPLAY)
  })

  it('keeps valid candle types and timezone', () => {
    const d = sanitizeDisplaySettings({
      timezone: 'Asia/Shanghai',
      candleType: 'area',
      gridShow: false,
      lastPriceShow: false,
      highPriceShow: true,
      lowPriceShow: false,
    })
    expect(d).toEqual({
      timezone: 'Asia/Shanghai',
      candleType: 'area',
      gridShow: false,
      lastPriceShow: false,
      highPriceShow: true,
      lowPriceShow: false,
    })
  })

  it('builds a Pro-compatible styles patch', () => {
    const patch = displayStylesPatch({
      ...DEFAULT_DISPLAY,
      candleType: 'ohlc',
      gridShow: false,
    }) as {
      grid: { show: boolean }
      candle: { type: string; priceMark: { last: { show: boolean } } }
    }
    expect(patch.grid.show).toBe(false)
    expect(patch.candle.type).toBe('ohlc')
    expect(patch.candle.priceMark.last.show).toBe(true)
  })

  it('notifies subscribers on change', () => {
    let n = 0
    const unsub = subscribeDisplaySettings(() => { n++ })
    setDisplaySettings({ ...DEFAULT_DISPLAY, timezone: 'Europe/London' })
    expect(n).toBe(1)
    expect(getDisplaySettings().timezone).toBe('Europe/London')
    setDisplaySettings(DEFAULT_DISPLAY)
    unsub()
  })
})
