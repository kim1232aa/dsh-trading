import { describe, expect, it } from 'vitest'
import { fetchFxBook, toBase } from '../src/fx.js'
import { summarizePortfolio, updatePositionMarketValue } from '../src/ledger.js'
import type { HoldingPosition } from '../src/types.js'

describe('FX NAV book', () => {
  it('fetches a live USDT-base book and converts CNY', async () => {
    const book = await fetchFxBook('USDT')
    expect(book.baseCurrency).toBe('USDT')
    expect(book.rates.USDT).toBeCloseTo(1, 2)
    expect(book.rates.USD).toBeGreaterThan(0.9)
    expect(book.rates.CNY).toBeGreaterThan(0.05)
    expect(book.rates.CNY).toBeLessThan(0.5)
    // 100 CNY → ~15 USDT
    const usdt = toBase(100, 'CNY', book)
    expect(usdt).toBeGreaterThan(10)
    expect(usdt).toBeLessThan(30)
  }, 20_000)

  it('weights positions by base NAV across USDT + CNY', () => {
    const eth = updatePositionMarketValue({
      symbol: 'ETHUSDT', assetClass: 'crypto', quantity: 1, sellableQuantity: 1,
      lockedQuantity: 0, averageCost: 2000, costBasis: 2000, realizedPnl: 0,
      currency: 'USDT', updatedAt: '',
    }, 2000)
    const moutai = updatePositionMarketValue({
      symbol: '600519', assetClass: 'equity', quantity: 10, sellableQuantity: 10,
      lockedQuantity: 0, averageCost: 1000, costBasis: 10000, realizedPnl: 0,
      currency: 'CNY', updatedAt: '',
    }, 1000)
    const fx = {
      baseCurrency: 'USDT' as const,
      asOf: '2026-10-14',
      source: 'test',
      rates: { USDT: 1, USD: 1, CNY: 0.15 },
    }
    const summary = summarizePortfolio([eth, moutai], 0, fx)
    expect(summary.nav?.totalNav).toBeCloseTo(2000 + 1000 * 10 * 0.15, 0) // 2000 + 1500 = 3500
    expect(summary.nav?.baseCurrency).toBe('USDT')
    const wEth = summary.positions.find(p => p.symbol === 'ETHUSDT')!.weightPct!
    const wMt = summary.positions.find(p => p.symbol === '600519')!.weightPct!
    expect(wEth + wMt).toBeCloseTo(100, 0)
    expect(wEth).toBeGreaterThan(wMt)
  })
})
