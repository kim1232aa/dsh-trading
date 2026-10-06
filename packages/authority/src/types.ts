/**
 * Cryptographic trade authority contracts & types.
 * @module @dsh-trading/authority
 */

export interface TradingGrantPayload {
  grantId: string
  issuedAt: string
  validUntil: string
  allowedSymbols: string[]
  maxPositionUSD: number
  mode: 'paper' | 'live'
}

export interface TradingGrantFile {
  payload: TradingGrantPayload
  signature: string
}

export interface AuthorityCheckRequest {
  symbol: string
  notionalUSD: number
  mode?: 'paper' | 'live' | undefined
}

export interface AuthorityVerdict {
  allowed: boolean
  mode: 'paper' | 'live' | 'blocked'
  reason: string
  grantId?: string | undefined
}
