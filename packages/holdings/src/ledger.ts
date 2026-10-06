/**
 * Pure mathematical accounting logic for holdings ledger.
 * Implements weighted-average cost basis and realized/unrealized PnL tracking.
 * @module @dsh-trading/holdings
 */

import type { AssetClass, Currency, HoldingPosition, PortfolioSummary, StagedTrade } from './types.js'

/** Heuristically infers asset class and quote currency from symbol ticker. */
export function inferAssetClassAndCurrency(symbol: string): { assetClass: AssetClass; currency: Currency } {
  const upper = symbol.toUpperCase()
  if (/^(SH|SZ|BJ)?\d{6}$/i.test(symbol)) {
    return { assetClass: 'equity', currency: 'CNY' }
  }
  if (/USDT$|USDC$|BUSD$|BTC$|ETH$|SOL$|DOGE$/i.test(upper)) {
    return { assetClass: 'crypto', currency: 'USDT' }
  }
  return { assetClass: 'equity', currency: 'USD' }
}

/** Creates a fresh zero position for a new symbol. */
export function createEmptyPosition(
  symbol: string,
  assetClass?: AssetClass,
  currency?: Currency,
): HoldingPosition {
  const inferred = inferAssetClassAndCurrency(symbol)
  return {
    symbol,
    assetClass: assetClass ?? inferred.assetClass,
    quantity: 0,
    averageCost: 0,
    realizedPnl: 0,
    currency: currency ?? inferred.currency,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Applies a committed trade execution to an existing position.
 * Returns the updated position and the incremental realized PnL change.
 */
export function applyTradeToPosition(
  pos: HoldingPosition,
  trade: StagedTrade,
): { position: HoldingPosition; realizedPnlDelta: number } {
  const fee = trade.fee ?? 0
  const isBuy = trade.side === 'buy' || trade.side === 'long'
  const isSell = trade.side === 'sell' || trade.side === 'short'

  let newQuantity = pos.quantity
  let newAvgCost = pos.averageCost
  let realizedPnlDelta = 0

  if (isBuy) {
    if (pos.quantity >= 0) {
      // Adding to long position or opening new long
      const currentTotalCost = pos.quantity * pos.averageCost
      const tradeTotalCost = trade.quantity * trade.price + fee
      newQuantity = pos.quantity + trade.quantity
      newAvgCost = newQuantity > 0 ? (currentTotalCost + tradeTotalCost) / newQuantity : 0
    } else {
      // Covering short position
      const closedQty = Math.min(Math.abs(pos.quantity), trade.quantity)
      realizedPnlDelta = (pos.averageCost - trade.price) * closedQty - fee
      newQuantity = pos.quantity + trade.quantity
      if (newQuantity > 0) {
        newAvgCost = trade.price
      } else if (newQuantity === 0) {
        newAvgCost = 0
      }
    }
  } else if (isSell) {
    if (pos.quantity > 0) {
      // Selling/reducing long position
      const closedQty = Math.min(pos.quantity, trade.quantity)
      realizedPnlDelta = (trade.price - pos.averageCost) * closedQty - fee
      newQuantity = pos.quantity - trade.quantity
      if (newQuantity <= 0) {
        newAvgCost = newQuantity < 0 ? trade.price : 0
      }
    } else {
      // Opening or adding to short position
      const currentTotalValue = Math.abs(pos.quantity) * pos.averageCost
      const tradeTotalValue = trade.quantity * trade.price - fee
      newQuantity = pos.quantity - trade.quantity
      newAvgCost = Math.abs(newQuantity) > 0 ? (currentTotalValue + tradeTotalValue) / Math.abs(newQuantity) : 0
    }
  }

  const updatedPosition: HoldingPosition = {
    ...pos,
    quantity: Number(newQuantity.toFixed(8)),
    averageCost: Number(newAvgCost.toFixed(4)),
    realizedPnl: Number((pos.realizedPnl + realizedPnlDelta).toFixed(4)),
    updatedAt: new Date().toISOString(),
  }

  // If position has a known currentPrice, recalculate market value and unrealized PnL
  if (pos.currentPrice !== undefined) {
    return {
      position: updatePositionMarketValue(updatedPosition, pos.currentPrice),
      realizedPnlDelta,
    }
  }

  return { position: updatedPosition, realizedPnlDelta }
}

/** Recalculates position's market value and unrealized PnL based on latest market price. */
export function updatePositionMarketValue(pos: HoldingPosition, currentPrice: number): HoldingPosition {
  const marketValue = Number((pos.quantity * currentPrice).toFixed(4))
  let unrealizedPnl = 0
  let unrealizedPnlPct = 0

  if (pos.quantity > 0 && pos.averageCost > 0) {
    unrealizedPnl = (currentPrice - pos.averageCost) * pos.quantity
    unrealizedPnlPct = ((currentPrice - pos.averageCost) / pos.averageCost) * 100
  } else if (pos.quantity < 0 && pos.averageCost > 0) {
    unrealizedPnl = (pos.averageCost - currentPrice) * Math.abs(pos.quantity)
    unrealizedPnlPct = ((pos.averageCost - currentPrice) / pos.averageCost) * 100
  }

  return {
    ...pos,
    currentPrice,
    marketValue,
    unrealizedPnl: Number(unrealizedPnl.toFixed(4)),
    unrealizedPnlPct: Number(unrealizedPnlPct.toFixed(2)),
    updatedAt: new Date().toISOString(),
  }
}

/** Summarizes portfolio positions into totals grouped by currency. */
export function summarizePortfolio(
  positions: HoldingPosition[],
  stagedTradesCount = 0,
): PortfolioSummary {
  const totalMarketValue: Record<string, number> = {}
  const totalUnrealizedPnl: Record<string, number> = {}
  const totalRealizedPnl: Record<string, number> = {}

  for (const pos of positions) {
    const cur = pos.currency
    totalMarketValue[cur] = Number(((totalMarketValue[cur] ?? 0) + (pos.marketValue ?? 0)).toFixed(2))
    totalUnrealizedPnl[cur] = Number(((totalUnrealizedPnl[cur] ?? 0) + (pos.unrealizedPnl ?? 0)).toFixed(2))
    totalRealizedPnl[cur] = Number(((totalRealizedPnl[cur] ?? 0) + pos.realizedPnl).toFixed(2))
  }

  return {
    positions,
    totalMarketValue,
    totalUnrealizedPnl,
    totalRealizedPnl,
    stagedTradesCount,
  }
}
