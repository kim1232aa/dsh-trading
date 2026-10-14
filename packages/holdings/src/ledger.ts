/**
 * Pure mathematical accounting logic for holdings ledger.
 * Weighted-average cost basis; broker-style mark-to-market fields.
 * @module @dsh-trading/holdings
 */

import type { FxBook } from './fx.js'
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

/** Asia/Shanghai calendar date YYYY-MM-DD for T+1 lock rollover. */
export function shanghaiDate(iso = new Date().toISOString()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}

/** Whether this asset class uses T+1 sellability (A-share equities). */
export function usesTPlusOne(assetClass: AssetClass, currency: Currency): boolean {
  return assetClass === 'equity' && currency === 'CNY'
}

function round(n: number, places: number): number {
  return Number(n.toFixed(places))
}

/** Clears stale T+1 locks when the Shanghai calendar day has rolled. */
export function rollLockedQuantity(pos: HoldingPosition, nowIso = new Date().toISOString()): HoldingPosition {
  if (!usesTPlusOne(pos.assetClass, pos.currency)) {
    const { lockDate: _drop, ...rest } = pos
    return { ...rest, lockedQuantity: 0, sellableQuantity: Math.max(0, pos.quantity) }
  }
  const today = shanghaiDate(nowIso)
  if (!pos.lockDate || pos.lockDate !== today) {
    const { lockDate: _drop, ...rest } = pos
    return {
      ...rest,
      lockedQuantity: 0,
      sellableQuantity: Math.max(0, pos.quantity),
    }
  }
  const locked = Math.min(Math.max(0, pos.lockedQuantity), Math.max(0, pos.quantity))
  return {
    ...pos,
    lockedQuantity: locked,
    sellableQuantity: Math.max(0, pos.quantity - locked),
  }
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
    sellableQuantity: 0,
    lockedQuantity: 0,
    averageCost: 0,
    costBasis: 0,
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
  nowIso = new Date().toISOString(),
): { position: HoldingPosition; realizedPnlDelta: number } {
  const fee = trade.fee ?? 0
  const isBuy = trade.side === 'buy' || trade.side === 'long'
  const isSell = trade.side === 'sell' || trade.side === 'short'
  let working = rollLockedQuantity(pos, nowIso)

  let newQuantity = working.quantity
  let newAvgCost = working.averageCost
  let realizedPnlDelta = 0
  let locked = working.lockedQuantity
  let lockDate = working.lockDate

  if (isBuy) {
    if (working.quantity >= 0) {
      const currentTotalCost = working.quantity * working.averageCost
      const tradeTotalCost = trade.quantity * trade.price + fee
      newQuantity = working.quantity + trade.quantity
      newAvgCost = newQuantity > 0 ? (currentTotalCost + tradeTotalCost) / newQuantity : 0
      if (usesTPlusOne(working.assetClass, working.currency)) {
        const today = shanghaiDate(nowIso)
        locked = (lockDate === today ? locked : 0) + trade.quantity
        lockDate = today
      }
    } else {
      const closedQty = Math.min(Math.abs(working.quantity), trade.quantity)
      realizedPnlDelta = (working.averageCost - trade.price) * closedQty - fee
      newQuantity = working.quantity + trade.quantity
      if (newQuantity > 0) {
        newAvgCost = trade.price
        if (usesTPlusOne(working.assetClass, working.currency)) {
          locked = newQuantity
          lockDate = shanghaiDate(nowIso)
        }
      } else if (newQuantity === 0) {
        newAvgCost = 0
        locked = 0
        lockDate = undefined
      }
    }
  } else if (isSell) {
    if (working.quantity > 0) {
      const closedQty = Math.min(working.quantity, trade.quantity)
      realizedPnlDelta = (trade.price - working.averageCost) * closedQty - fee
      newQuantity = working.quantity - trade.quantity
      // Consume free (sellable) shares first, then locked.
      const sellable = Math.max(0, working.quantity - locked)
      const fromFree = Math.min(closedQty, sellable)
      const fromLocked = closedQty - fromFree
      locked = Math.max(0, locked - fromLocked)
      if (newQuantity <= 0) {
        newAvgCost = newQuantity < 0 ? trade.price : 0
        locked = newQuantity < 0 ? 0 : locked
        if (newQuantity === 0) lockDate = undefined
      }
    } else {
      const currentTotalValue = Math.abs(working.quantity) * working.averageCost
      const tradeTotalValue = trade.quantity * trade.price - fee
      newQuantity = working.quantity - trade.quantity
      newAvgCost = Math.abs(newQuantity) > 0 ? (currentTotalValue + tradeTotalValue) / Math.abs(newQuantity) : 0
      locked = 0
      lockDate = undefined
    }
  }

  const { lockDate: _oldLock, ...workingRest } = working
  let updatedPosition: HoldingPosition = {
    ...workingRest,
    quantity: round(newQuantity, 8),
    averageCost: round(newAvgCost, 4),
    costBasis: round(Math.abs(newQuantity) * newAvgCost, 4),
    lockedQuantity: round(Math.max(0, locked), 8),
    ...(lockDate !== undefined ? { lockDate } : {}),
    realizedPnl: round(working.realizedPnl + realizedPnlDelta, 4),
    updatedAt: nowIso,
  }
  // Recompute sellable after qty/lock change.
  updatedPosition = rollLockedQuantity(updatedPosition, nowIso)
  updatedPosition = {
    ...updatedPosition,
    costBasis: round(Math.abs(updatedPosition.quantity) * updatedPosition.averageCost, 4),
  }

  if (working.currentPrice !== undefined) {
    return {
      position: updatePositionMarketValue(updatedPosition, working.currentPrice, working.previousClose),
      realizedPnlDelta,
    }
  }

  return { position: updatedPosition, realizedPnlDelta }
}

/**
 * Recalculates mark-to-market fields.
 * previousClose (昨收) drives 今日盈亏 when provided.
 */
export function updatePositionMarketValue(
  pos: HoldingPosition,
  currentPrice: number,
  previousClose?: number,
): HoldingPosition {
  const rolled = rollLockedQuantity(pos)
  const qty = rolled.quantity
  const marketValue = round(qty * currentPrice, 4)
  const costBasis = round(Math.abs(qty) * rolled.averageCost, 4)
  let unrealizedPnl = 0
  let unrealizedPnlPct = 0

  if (qty > 0 && rolled.averageCost > 0) {
    unrealizedPnl = (currentPrice - rolled.averageCost) * qty
    unrealizedPnlPct = ((currentPrice - rolled.averageCost) / rolled.averageCost) * 100
  } else if (qty < 0 && rolled.averageCost > 0) {
    unrealizedPnl = (rolled.averageCost - currentPrice) * Math.abs(qty)
    unrealizedPnlPct = ((rolled.averageCost - currentPrice) / rolled.averageCost) * 100
  }

  let todayPnl: number | undefined
  let todayPnlPct: number | undefined
  const prev = previousClose ?? rolled.previousClose
  if (prev !== undefined && prev > 0 && qty !== 0) {
    todayPnl = round((currentPrice - prev) * qty, 4)
    todayPnlPct = round(((currentPrice - prev) / prev) * 100, 2)
  }

  return {
    ...rolled,
    currentPrice,
    ...(prev !== undefined ? { previousClose: prev } : {}),
    costBasis,
    marketValue,
    unrealizedPnl: round(unrealizedPnl, 4),
    unrealizedPnlPct: round(unrealizedPnlPct, 2),
    ...(todayPnl !== undefined && todayPnlPct !== undefined ? { todayPnl, todayPnlPct } : {}),
    updatedAt: new Date().toISOString(),
  }
}

/** Summarizes portfolio positions into broker-style totals grouped by currency (+ optional USDT NAV). */
export function summarizePortfolio(
  positions: HoldingPosition[],
  stagedTradesCount = 0,
  fx?: FxBook,
): PortfolioSummary {
  const totalMarketValue: Record<string, number> = {}
  const totalCost: Record<string, number> = {}
  const totalUnrealizedPnl: Record<string, number> = {}
  const totalRealizedPnl: Record<string, number> = {}
  const totalTodayPnl: Record<string, number> = {}
  const longExposure: Record<string, number> = {}
  const shortExposure: Record<string, number> = {}

  const rate = (ccy: string): number => (fx ? (fx.rates[ccy] ?? 1) : 1)

  // Weight denominator: base-NAV abs when FX present, else per-currency abs MV.
  let absNav = 0
  const absMv: Record<string, number> = {}
  for (const pos of positions) {
    const mv = Math.abs(pos.marketValue ?? 0)
    absMv[pos.currency] = (absMv[pos.currency] ?? 0) + mv
    if (fx) absNav += mv * rate(pos.currency)
  }

  const enriched: HoldingPosition[] = positions.map((pos) => {
    const mv = pos.marketValue ?? 0
    const weightPct = fx
      ? (absNav > 0 ? round((Math.abs(mv) * rate(pos.currency) / absNav) * 100, 2) : 0)
      : ((absMv[pos.currency] ?? 0) > 0 ? round((Math.abs(mv) / (absMv[pos.currency] ?? 1)) * 100, 2) : 0)
    return { ...pos, weightPct, costBasis: round(Math.abs(pos.quantity) * pos.averageCost, 4) }
  })

  for (const pos of enriched) {
    const cur = pos.currency
    const mv = pos.marketValue ?? 0
    totalMarketValue[cur] = round((totalMarketValue[cur] ?? 0) + mv, 2)
    totalCost[cur] = round((totalCost[cur] ?? 0) + (pos.costBasis ?? 0), 2)
    totalUnrealizedPnl[cur] = round((totalUnrealizedPnl[cur] ?? 0) + (pos.unrealizedPnl ?? 0), 2)
    totalRealizedPnl[cur] = round((totalRealizedPnl[cur] ?? 0) + pos.realizedPnl, 2)
    if (pos.todayPnl !== undefined) {
      totalTodayPnl[cur] = round((totalTodayPnl[cur] ?? 0) + pos.todayPnl, 2)
    }
    if (mv >= 0) longExposure[cur] = round((longExposure[cur] ?? 0) + mv, 2)
    else shortExposure[cur] = round((shortExposure[cur] ?? 0) + Math.abs(mv), 2)
  }

  const totalUnrealizedPnlPct: Record<string, number> = {}
  const netExposure: Record<string, number> = {}
  for (const cur of Object.keys({ ...totalCost, ...longExposure, ...shortExposure })) {
    const cost = totalCost[cur] ?? 0
    const upnl = totalUnrealizedPnl[cur] ?? 0
    totalUnrealizedPnlPct[cur] = cost > 0 ? round((upnl / cost) * 100, 2) : 0
    netExposure[cur] = round((longExposure[cur] ?? 0) - (shortExposure[cur] ?? 0), 2)
  }

  let maxWeightPct: number | null = null
  let maxWeightSymbol: string | null = null
  for (const pos of enriched) {
    const w = pos.weightPct ?? 0
    if (maxWeightPct === null || w > maxWeightPct) {
      maxWeightPct = w
      maxWeightSymbol = pos.symbol
    }
  }

  let nav: PortfolioSummary['nav']
  if (fx) {
    let totalNav = 0, totalCostNav = 0, totalUnrealizedPnlNav = 0, totalTodayPnlNav = 0
    let longExposureNav = 0, shortExposureNav = 0
    for (const pos of enriched) {
      const r = rate(pos.currency)
      const mv = (pos.marketValue ?? 0) * r
      totalNav += mv
      totalCostNav += (pos.costBasis ?? 0) * r
      totalUnrealizedPnlNav += (pos.unrealizedPnl ?? 0) * r
      totalTodayPnlNav += (pos.todayPnl ?? 0) * r
      if (mv >= 0) longExposureNav += mv
      else shortExposureNav += Math.abs(mv)
    }
    nav = {
      baseCurrency: fx.baseCurrency,
      asOf: fx.asOf,
      source: fx.source,
      rates: { ...fx.rates },
      totalNav: round(totalNav, 2),
      totalCostNav: round(totalCostNav, 2),
      totalUnrealizedPnlNav: round(totalUnrealizedPnlNav, 2),
      totalUnrealizedPnlPct: totalCostNav > 0 ? round((totalUnrealizedPnlNav / totalCostNav) * 100, 2) : 0,
      totalTodayPnlNav: round(totalTodayPnlNav, 2),
      longExposureNav: round(longExposureNav, 2),
      shortExposureNav: round(shortExposureNav, 2),
      netExposureNav: round(longExposureNav - shortExposureNav, 2),
      note: `NAV in ${fx.baseCurrency}; USD≈USDT near-par; fiat via public USD book (${fx.source}). Research mark, not settlement.`,
    }
  }

  return {
    positions: enriched,
    totalMarketValue,
    totalCost,
    totalUnrealizedPnl,
    totalUnrealizedPnlPct,
    totalRealizedPnl,
    totalTodayPnl,
    longExposure,
    shortExposure,
    netExposure,
    maxWeightPct,
    maxWeightSymbol,
    stagedTradesCount,
    ...(nav ? { nav } : {}),
  }
}

/** Drop keys whose value is `undefined` so tool results stay lossless-JSON. */
export function omitUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out as T
}
