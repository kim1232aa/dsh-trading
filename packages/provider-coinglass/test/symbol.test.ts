import { describe, expect, it } from 'vitest'
import { normalizePair, toCgSymbol } from '../src/symbol.js'

describe('toCgSymbol', () => {
  it('maps BTCUSDT to Binance_BTCUSDT', () => {
    expect(toCgSymbol('BTCUSDT')).toEqual({
      pair: 'BTCUSDT',
      exchange: 'Binance',
      market: 'perp',
      cgSymbol: 'Binance_BTCUSDT',
    })
  })

  it('maps spot:ETHUSDT and okx:BTCUSDT', () => {
    expect(toCgSymbol('spot:ETHUSDT').cgSymbol).toBe('Binance_SPOT_ETHUSDT')
    expect(toCgSymbol('okx:BTCUSDT').cgSymbol).toBe('OKX_BTCUSDT')
    expect(toCgSymbol('OKX_SPOT_ETHUSDT').cgSymbol).toBe('OKX_SPOT_ETHUSDT')
  })

  it('normalizes separators and bare base', () => {
    expect(normalizePair('btc/usdt')).toBe('BTCUSDT')
    expect(normalizePair('ETH')).toBe('ETHUSDT')
  })
})
