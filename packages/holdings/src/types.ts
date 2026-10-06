/**
 * Holdings and trade ledger types.
 * Supports two-zone safety model (staged candidates vs committed positions).
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
  fee?: number | undefined
  notes?: string | undefined
  stagedAt: string
  committedAt?: string | undefined
  status: 'staged' | 'committed' | 'discarded'
}

export interface HoldingPosition {
  symbol: string
  assetClass: AssetClass
  quantity: number
  averageCost: number
  currentPrice?: number | undefined
  marketValue?: number | undefined
  unrealizedPnl?: number | undefined
  unrealizedPnlPct?: number | undefined
  realizedPnl: number
  currency: Currency
  updatedAt: string
}

export interface PortfolioSummary {
  positions: HoldingPosition[]
  totalMarketValue: Record<string, number>
  totalUnrealizedPnl: Record<string, number>
  totalRealizedPnl: Record<string, number>
  stagedTradesCount: number
}
