/** One large limit-order wall from CoinGlass capi. */
export interface LargeOrderWall {
  id: string | number
  /** Venue display name, e.g. Binance / OKX. */
  exchange: string
  baseAsset?: string
  /** Normalized market type ('spot' | 'perp'). */
  market?: 'spot' | 'perp'
  /** Exchange instrument identifier (e.g. BTC-USDT-SWAP, BTCUSDT, BTC-USD). */
  instrumentId?: string
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
  /** Epoch ms of the primary pull behind this snapshot (older than now when served from cache). */
  updatedAt?: number
  /**
   * True when CoinGlass refused or failed the primary pull (HTTP 429, network)
   * and this is the last good pull instead; `updatedAt` says how old it is.
   */
  stale?: boolean
  /** Venue queries that failed this round; their walls are missing from `walls`. */
  failedSources?: number
}

export interface FetchLargeOrdersOptions {
  /** Hours of history window. Default 72. */
  hours?: number
  /** Keep top N by currentUsd. Default 40. */
  top?: number
  /** Filter to one venue after flatten (e.g. Binance). */
  venue?: string
  /** Filter walls by market type: 'all' (default), 'spot', or 'perp'. */
  marketType?: 'all' | 'spot' | 'perp'
  /** Drop walls whose currentUsd is below this (e.g. 1_000_000 for $100万). */
  minUsd?: number
  /** Optional price band for statistics. */
  minPrice?: number
  maxPrice?: number
  /** AbortSignal. */
  signal?: AbortSignal
  /**
   * Filter order status.
   * 'active' (default): only still-resting open limit orders (state === 1).
   * 'all': include both resting and historical completed/revoked orders.
   * 'revoked': only cancelled/revoked orders (state === 2).
   */
  status?: 'active' | 'all' | 'revoked'
  /** Current market price for distance filtering and symmetric buy/sell grouping. */
  currentPrice?: number
  /** Maximum distance ratio from currentPrice (e.g. 0.3 = ±30%). */
  maxDistancePct?: number
  /** Whether to balance top walls evenly between buy (support) and sell (resistance). Default true. */
  balanced?: boolean
  /** Also pull venue statistics (one extra request). Default true; the chart strip does not use them. */
  statistics?: boolean
}
