import { describe, expect, it } from 'vitest'
import {
  closestSymbol,
  crowdVsWhaleOf,
  normalizeSymbol,
  postureOf,
} from '../src/index.js'

describe('Binance Provider Helpers', () => {
  it('normalizes various symbol representations', () => {
    expect(normalizeSymbol('ETHUSDT')).toBe('ETHUSDT')
    expect(normalizeSymbol('ethusdt')).toBe('ETHUSDT')
    expect(normalizeSymbol('ETH/USDT')).toBe('ETHUSDT')
    expect(normalizeSymbol('eth_usdt')).toBe('ETHUSDT')
    expect(normalizeSymbol('ETH-USDT')).toBe('ETHUSDT')
    expect(normalizeSymbol('ETH')).toBe('ETHUSDT')
    expect(normalizeSymbol('btc')).toBe('BTCUSDT')
    expect(normalizeSymbol('ETHUDST')).toBe('ETHUSDT')
    expect(normalizeSymbol('ETHUSTD')).toBe('ETHUSDT')
  })

  it('suggests closest symbol on typos', () => {
    const list = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']
    expect(closestSymbol('ETUUSDT', list)).toBe('ETHUSDT')
    expect(closestSymbol('BCUSDT', list)).toBe('BTCUSDT')
    expect(closestSymbol('XYZNOTFOUND', list)).toBeNull()
  })

  it('derives posture correctly from price and OI deltas', () => {
    expect(postureOf(1.5, 2.0, false)).toBe('多头增仓')
    expect(postureOf(-1.5, 2.0, false)).toBe('空头增仓')
    expect(postureOf(1.5, -2.0, false)).toBe('空头回补')
    expect(postureOf(-1.5, -2.0, false)).toBe('多头平仓')
    expect(postureOf(1.5, 2.0, true)).toBe('价涨增仓 (多头增仓为主)')
    expect(postureOf(0.01, 0.01, false)).toBe('持仓持平')
  })

  it('derives crowd vs whale sentiment correctly', () => {
    expect(crowdVsWhaleOf(2.0, 1.2)).toBe('散户极度接多(多73%+)，大户未跟偏空 (对手盘风险)')
    expect(crowdVsWhaleOf(0.7, 1.6)).toBe('散户恐慌割肉做空，大户逆势吸筹做多')
    expect(crowdVsWhaleOf(1.6, 1.9)).toBe('大户散户共识做多')
    expect(crowdVsWhaleOf(0.7, 0.9)).toBe('大户散户共识做空')
    expect(crowdVsWhaleOf(1.0, 1.0)).toBeNull()
  })
})
