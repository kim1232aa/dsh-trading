/**
 * Watchlist types and state contracts.
 * @module @dsh-trading/watchlist
 */

export interface WatchlistItem {
  symbol: string
  group: string
  notes?: string | undefined
  addedAt: string
  sortOrder?: number | undefined
}

export interface WatchlistState {
  items: WatchlistItem[]
  groups: string[]
}
