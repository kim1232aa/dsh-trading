/**
 * Holdings and trade ledger types.
 * Supports two-zone safety model (staged candidates vs committed positions).
 * Field set aligned with common broker UIs (Futu/Moomoo/IB): quantity,
 * sellable qty, cost, mark, market value, unrealized/realized/today PnL, weight.
 * @module @dsh-trading/holdings
 */

export type TradeSide = 'buy' | 'sell' | 'long' | 'short'

export type AssetClass = 'equity' | 'crypto' | 'future' | 'cash'

export type Currency = 'CNY' | 'USD' | 'USDT'

export interface StagedTrade {
  id: string
  symbol: string
  side: TradeSide
  quantity: number
  price: number
  currency: Currency
  fee?: number
  notes?: string
  stagedAt: string
  committedAt?: string
  status: 'staged' | 'committed' | 'discarded'
}

export interface HoldingPosition {
  symbol: string
  assetClass: AssetClass
  /** Signed quantity: >0 long, <0 short. */
  quantity: number
  /**
   * Sellable quantity (可卖). For CN A-shares, same-day buys are locked (T+1);
   * crypto/US are fully sellable. Always ≥ 0 and ≤ max(quantity, 0).
   */
  sellableQuantity: number
  /** Quantity bought today still under T+1 lock (A-shares only). */
  lockedQuantity: number
  /** Calendar date (Asia/Shanghai YYYY-MM-DD) of the locked lots; cleared next day. */
  lockDate?: string
  /**
   * 成本价 / 摊薄成本: weighted-average cost of the open lot (fees included on buys).
   * Partial sells keep this average on the remaining shares (average-cost method).
   */
  averageCost: number
  /** 持仓成本 = averageCost × |quantity|. */
  costBasis: number
  currentPrice?: number
  /** Previous session close (昨收), used for 今日盈亏. */
  previousClose?: number
  marketValue?: number
  /** 盈亏金额 = (现价 − 成本价) × 数量 (short flips the sign). */
  unrealizedPnl?: number
  /** 盈亏比例 = 盈亏金额 / (成本价 × |数量|) × 100. */
  unrealizedPnlPct?: number
  /** 今日盈亏 = (现价 − 昨收) × 数量. */
  todayPnl?: number
  todayPnlPct?: number
  /** Cumulative realized PnL from closed lots. */
  realizedPnl: number
  /** 持仓占比 = |市值| / 组合总市值(同币种) × 100. Filled by summarizePortfolio. */
  weightPct?: number
  currency: Currency
  updatedAt: string
}

export interface PortfolioSummary {
  positions: HoldingPosition[]
  /** 总市值 by currency (signed market values summed). */
  totalMarketValue: Record<string, number>
  /** 总成本 by currency (sum of costBasis). */
  totalCost: Record<string, number>
  totalUnrealizedPnl: Record<string, number>
  /** 总未实现盈亏比例 = totalUnrealized / totalCost × 100. */
  totalUnrealizedPnlPct: Record<string, number>
  totalRealizedPnl: Record<string, number>
  totalTodayPnl: Record<string, number>
  /** Long market-value exposure (sum of positive market values). */
  longExposure: Record<string, number>
  /** Short market-value exposure as a positive number. */
  shortExposure: Record<string, number>
  /** Net = long − short. */
  netExposure: Record<string, number>
  /** Largest single-name |weightPct|. */
  maxWeightPct: number | null
  maxWeightSymbol: string | null
  stagedTradesCount: number
}
