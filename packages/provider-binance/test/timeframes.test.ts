import { describe, expect, it } from 'vitest'
import {
  BINANCE_TIMEFRAMES,
  GATE_TIMEFRAMES,
  OKX_TIMEFRAMES,
  OkxMarketProvider,
} from '../src/index.js'

describe('venue timeframe maps', () => {
  it('Binance advertises the full seam set including 3m/2h/6h/8h/12h/3d/1M', () => {
    expect(BINANCE_TIMEFRAMES).toEqual([
      '1m', '3m', '5m', '15m', '30m',
      '1h', '2h', '4h', '6h', '8h', '12h',
      '1d', '3d', '1w', '1M',
    ])
  })

  it('OKX omits 8h and still covers the other expanded intervals', () => {
    expect(OKX_TIMEFRAMES).toContain('3m')
    expect(OKX_TIMEFRAMES).toContain('2h')
    expect(OKX_TIMEFRAMES).toContain('6h')
    expect(OKX_TIMEFRAMES).toContain('12h')
    expect(OKX_TIMEFRAMES).toContain('3d')
    expect(OKX_TIMEFRAMES).toContain('1M')
    expect(OKX_TIMEFRAMES).not.toContain('8h')
  })

  it('Gate covers 8h/1M and rejects 3m/2h/6h/12h/3d', () => {
    expect(GATE_TIMEFRAMES).toEqual(
      expect.arrayContaining(['1m', '5m', '15m', '30m', '1h', '4h', '8h', '1d', '1w', '1M']),
    )
    for (const tf of ['3m', '2h', '6h', '12h', '3d'] as const) {
      expect(GATE_TIMEFRAMES).not.toContain(tf)
    }
  })

  it('OkxMarketProvider.listSymbols does not advertise 8h', async () => {
    const p = new OkxMarketProvider('okx', ['BTCUSDT'])
    const list = await p.listSymbols()
    expect(list[0]?.timeframes).toEqual(OKX_TIMEFRAMES)
    expect(list[0]?.timeframes).not.toContain('8h')
  })

  it('OkxMarketProvider.getOhlcv rejects 8h cleanly', async () => {
    const p = new OkxMarketProvider('okx', ['BTCUSDT'])
    await expect(p.getOhlcv({ symbol: 'BTCUSDT', timeframe: '8h' }))
      .rejects.toThrow(/unsupported timeframe 8h/)
  })
})
