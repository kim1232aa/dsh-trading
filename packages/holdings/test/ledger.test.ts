import { describe, expect, it } from 'vitest'
import {
  applyTradeToPosition,
  createEmptyPosition,
  inferAssetClassAndCurrency,
  rollLockedQuantity,
  shanghaiDate,
  summarizePortfolio,
  updatePositionMarketValue,
} from '../src/ledger.js'
import type { HoldingPosition, StagedTrade } from '../src/types.js'

describe('Holdings Ledger Accounting Math', () => {
  it('infers asset class and currency correctly', () => {
    expect(inferAssetClassAndCurrency('600519')).toEqual({ assetClass: 'equity', currency: 'CNY' })
    expect(inferAssetClassAndCurrency('ETHUSDT')).toEqual({ assetClass: 'crypto', currency: 'USDT' })
    expect(inferAssetClassAndCurrency('AAPL')).toEqual({ assetClass: 'equity', currency: 'USD' })
  })

  it('calculates weighted average cost on multiple buys', () => {
    let pos = createEmptyPosition('ETHUSDT', 'crypto', 'USDT')
    const trade1: StagedTrade = {
      id: 't1', symbol: 'ETHUSDT', side: 'buy', quantity: 10, price: 2000,
      currency: 'USDT', stagedAt: '2026-10-01T00:00:00Z', status: 'staged',
    }
    pos = applyTradeToPosition(pos, trade1).position
    expect(pos.quantity).toBe(10)
    expect(pos.averageCost).toBe(2000)
    expect(pos.costBasis).toBe(20000)
    expect(pos.sellableQuantity).toBe(10) // crypto: no T+1
    expect(pos.lockedQuantity).toBe(0)

    const trade2: StagedTrade = {
      id: 't2', symbol: 'ETHUSDT', side: 'buy', quantity: 10, price: 3000,
      currency: 'USDT', stagedAt: '2026-10-02T00:00:00Z', status: 'staged',
    }
    pos = applyTradeToPosition(pos, trade2).position
    expect(pos.quantity).toBe(20)
    expect(pos.averageCost).toBe(2500)
    expect(pos.costBasis).toBe(50000)
  })

  it('locks same-day A-share buys under T+1 (可卖 < 持仓)', () => {
    let pos = createEmptyPosition('600519', 'equity', 'CNY')
    const now = '2026-10-14T08:00:00.000Z' // Shanghai 16:00 same day
    const buy: StagedTrade = {
      id: 't1', symbol: '600519', side: 'buy', quantity: 100, price: 1280,
      currency: 'CNY', stagedAt: now, status: 'staged',
    }
    pos = applyTradeToPosition(pos, buy, now).position
    expect(pos.quantity).toBe(100)
    expect(pos.lockedQuantity).toBe(100)
    expect(pos.sellableQuantity).toBe(0)
    expect(pos.lockDate).toBe(shanghaiDate(now))

    // Next Shanghai day unlocks
    const next = '2026-10-15T01:00:00.000Z'
    pos = rollLockedQuantity(pos, next)
    expect(pos.lockedQuantity).toBe(0)
    expect(pos.sellableQuantity).toBe(100)
  })

  it('calculates realized PnL on selling long position', () => {
    const pos: HoldingPosition = {
      symbol: 'ETHUSDT', assetClass: 'crypto', quantity: 20, sellableQuantity: 20,
      lockedQuantity: 0, averageCost: 2500, costBasis: 50000, realizedPnl: 0,
      currency: 'USDT', updatedAt: '2026-10-02T00:00:00Z',
    }
    const sellTrade: StagedTrade = {
      id: 't3', symbol: 'ETHUSDT', side: 'sell', quantity: 5, price: 2800,
      currency: 'USDT', fee: 10, stagedAt: '2026-10-03T00:00:00Z', status: 'staged',
    }
    const { position, realizedPnlDelta } = applyTradeToPosition(pos, sellTrade)
    expect(position.quantity).toBe(15)
    expect(position.averageCost).toBe(2500)
    expect(position.costBasis).toBe(37500)
    expect(realizedPnlDelta).toBe(1490)
    expect(position.realizedPnl).toBe(1490)
  })

  it('updates mark, unrealized and today PnL', () => {
    const pos: HoldingPosition = {
      symbol: 'ETHUSDT', assetClass: 'crypto', quantity: 10, sellableQuantity: 10,
      lockedQuantity: 0, averageCost: 2500, costBasis: 25000, realizedPnl: 0,
      currency: 'USDT', updatedAt: '2026-10-01T00:00:00Z',
    }
    const updated = updatePositionMarketValue(pos, 2750, 2600)
    expect(updated.currentPrice).toBe(2750)
    expect(updated.previousClose).toBe(2600)
    expect(updated.marketValue).toBe(27500)
    expect(updated.unrealizedPnl).toBe(2500)
    expect(updated.unrealizedPnlPct).toBe(10)
    expect(updated.todayPnl).toBe(1500) // (2750-2600)*10
    expect(updated.todayPnlPct).toBe(5.77)
  })

  it('summarizes portfolio with weight, exposure and concentration', () => {
    const pos1 = updatePositionMarketValue(
      { symbol: 'ETHUSDT', assetClass: 'crypto', quantity: 2, sellableQuantity: 2, lockedQuantity: 0, averageCost: 2500, costBasis: 5000, realizedPnl: 100, currency: 'USDT', updatedAt: '' },
      2700, 2600,
    )
    const pos2 = updatePositionMarketValue(
      { symbol: 'BTCUSDT', assetClass: 'crypto', quantity: 1, sellableQuantity: 1, lockedQuantity: 0, averageCost: 80000, costBasis: 80000, realizedPnl: 0, currency: 'USDT', updatedAt: '' },
      90000, 88000,
    )
    const summary = summarizePortfolio([pos1, pos2], 1)
    expect(summary.totalMarketValue.USDT).toBe(5400 + 90000)
    expect(summary.totalCost.USDT).toBe(5000 + 80000)
    expect(summary.totalUnrealizedPnl.USDT).toBe(400 + 10000)
    expect(summary.totalUnrealizedPnlPct.USDT).toBeCloseTo((10400 / 85000) * 100, 1)
    expect(summary.longExposure.USDT).toBe(95400)
    expect(summary.shortExposure.USDT ?? 0).toBe(0)
    expect(summary.netExposure.USDT).toBe(95400)
    expect(summary.maxWeightSymbol).toBe('BTCUSDT')
    expect(summary.maxWeightPct).toBeGreaterThan(90)
    const btc = summary.positions.find(p => p.symbol === 'BTCUSDT')!
    expect(btc.weightPct).toBeGreaterThan(90)
  })
})
