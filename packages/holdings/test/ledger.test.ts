import { describe, expect, it } from 'vitest'
import {
  applyTradeToPosition,
  createEmptyPosition,
  inferAssetClassAndCurrency,
  summarizePortfolio,
  updatePositionMarketValue,
} from '../src/ledger.js'
import type { HoldingPosition, StagedTrade } from '../src/types.js'

describe('Holdings Ledger Accounting Math', () => {
  it('infers asset class and currency correctly', () => {
    expect(inferAssetClassAndCurrency('600519')).toEqual({ assetClass: 'equity', currency: 'CNY' })
    expect(inferAssetClassAndCurrency('000001')).toEqual({ assetClass: 'equity', currency: 'CNY' })
    expect(inferAssetClassAndCurrency('ETHUSDT')).toEqual({ assetClass: 'crypto', currency: 'USDT' })
    expect(inferAssetClassAndCurrency('BTCUSDT')).toEqual({ assetClass: 'crypto', currency: 'USDT' })
    expect(inferAssetClassAndCurrency('AAPL')).toEqual({ assetClass: 'equity', currency: 'USD' })
  })

  it('calculates weighted average cost on multiple buys', () => {
    let pos = createEmptyPosition('ETHUSDT', 'crypto', 'USDT')

    // First buy: 10 ETH @ 2000
    const trade1: StagedTrade = {
      id: 't1',
      symbol: 'ETHUSDT',
      side: 'buy',
      quantity: 10,
      price: 2000,
      currency: 'USDT',
      stagedAt: '2026-10-01T00:00:00Z',
      status: 'staged',
    }
    const r1 = applyTradeToPosition(pos, trade1)
    pos = r1.position

    expect(pos.quantity).toBe(10)
    expect(pos.averageCost).toBe(2000)
    expect(pos.realizedPnl).toBe(0)
    expect(r1.realizedPnlDelta).toBe(0)

    // Second buy: 10 ETH @ 3000
    const trade2: StagedTrade = {
      id: 't2',
      symbol: 'ETHUSDT',
      side: 'buy',
      quantity: 10,
      price: 3000,
      currency: 'USDT',
      stagedAt: '2026-10-02T00:00:00Z',
      status: 'staged',
    }
    const r2 = applyTradeToPosition(pos, trade2)
    pos = r2.position

    expect(pos.quantity).toBe(20)
    expect(pos.averageCost).toBe(2500) // (10*2000 + 10*3000) / 20 = 2500
    expect(pos.realizedPnl).toBe(0)
  })

  it('calculates realized PnL on selling long position', () => {
    let pos: HoldingPosition = {
      symbol: 'ETHUSDT',
      assetClass: 'crypto',
      quantity: 20,
      averageCost: 2500,
      realizedPnl: 0,
      currency: 'USDT',
      updatedAt: '2026-10-02T00:00:00Z',
    }

    // Sell 5 ETH @ 2800 with 10 USDT fee
    const sellTrade: StagedTrade = {
      id: 't3',
      symbol: 'ETHUSDT',
      side: 'sell',
      quantity: 5,
      price: 2800,
      currency: 'USDT',
      fee: 10,
      stagedAt: '2026-10-03T00:00:00Z',
      status: 'staged',
    }

    const { position, realizedPnlDelta } = applyTradeToPosition(pos, sellTrade)

    expect(position.quantity).toBe(15)
    expect(position.averageCost).toBe(2500) // Average cost basis remains unchanged on partial sale
    // Realized PnL = (2800 - 2500) * 5 - 10 = 1500 - 10 = 1490
    expect(realizedPnlDelta).toBe(1490)
    expect(position.realizedPnl).toBe(1490)
  })

  it('updates position market value and unrealized PnL', () => {
    const pos: HoldingPosition = {
      symbol: 'ETHUSDT',
      assetClass: 'crypto',
      quantity: 10,
      averageCost: 2500,
      realizedPnl: 0,
      currency: 'USDT',
      updatedAt: '2026-10-01T00:00:00Z',
    }

    const updated = updatePositionMarketValue(pos, 2750)

    expect(updated.currentPrice).toBe(2750)
    expect(updated.marketValue).toBe(27500)
    // Unrealized PnL = (2750 - 2500) * 10 = +2500 USDT (+10.0%)
    expect(updated.unrealizedPnl).toBe(2500)
    expect(updated.unrealizedPnlPct).toBe(10)
  })

  it('summarizes multi-currency portfolio', () => {
    const pos1 = updatePositionMarketValue(
      { symbol: 'ETHUSDT', assetClass: 'crypto', quantity: 2, averageCost: 2500, realizedPnl: 100, currency: 'USDT', updatedAt: '' },
      2700,
    )
    const pos2 = updatePositionMarketValue(
      { symbol: '600519', assetClass: 'equity', quantity: 100, averageCost: 1500, realizedPnl: 5000, currency: 'CNY', updatedAt: '' },
      1550,
    )

    const summary = summarizePortfolio([pos1, pos2], 2)

    expect(summary.stagedTradesCount).toBe(2)
    expect(summary.totalMarketValue.USDT).toBe(5400)
    expect(summary.totalUnrealizedPnl.USDT).toBe(400)
    expect(summary.totalRealizedPnl.USDT).toBe(100)

    expect(summary.totalMarketValue.CNY).toBe(155000)
    expect(summary.totalUnrealizedPnl.CNY).toBe(5000)
    expect(summary.totalRealizedPnl.CNY).toBe(5000)
  })
})
