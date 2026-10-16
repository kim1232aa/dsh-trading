/** One large limit-order wall from CoinGlass capi. */
export interface LargeOrderWall {
  id: string | number
  /** Venue display name, e.g. Binance / OKX. */
  exchange: string
  baseAsset?: string
  /** PERPETUAL / spot type label from instrument. */
  market?: string
  side: 'buy' | 'sell'
  price: number
  startUsd: number
  currentUsd: number
  startAmount: number
  currentAmount: number
  volUsd: number
  /** 1 = still resting. */
  state: number
  /** Wall first seen (ms). */
  startTime: number
  /** Last update (ms). */
  currentTime: number
}

export interface LargeOrderStatistics {
  exchange: string
  baseAsset?: string
  market?: string
  bidsTotalUsd: number
  asksTotalUsd: number
  buyVolUsd?: number
  sellVolUsd?: number
}

export interface LargeOrdersSnapshot {
  /** CoinGlass symbol actually queried. */
  cgSymbol: string
  /** dsh-facing pair, e.g. BTCUSDT. */
  pair: string
  startTime: number
  endTime: number
  walls: LargeOrderWall[]
  statistics: LargeOrderStatistics[]
  /** How many raw walls before top-N trim. */
  orderCount: number
}

export interface FetchLargeOrdersOptions {
  /** Hours of history window. Default 72. */
  hours?: number
  /** Keep top N by currentUsd. Default 40. */
  top?: number
  /** Filter to one venue after flatten (e.g. Binance). */
  venue?: string
  /** Drop walls whose currentUsd is below this (e.g. 1_000_000 for $100万). */
  minUsd?: number
  /** Optional price band for statistics. */
  minPrice?: number
  maxPrice?: number
  /** AbortSignal. */
  signal?: AbortSignal
}
