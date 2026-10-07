/**
 * The provider-facing vocabulary of the market-data seam. This module is
 * dependency-free on purpose: a provider implements these types and nothing
 * else, so bringing your own data never pulls in harness internals.
 * @module @dsh-trading/market-data
 */

/** Supported bar intervals. Providers may serve a subset. */
export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w'

/** One OHLCV bar. `time` is the bar OPEN time as an ISO-8601 UTC string. */
export interface Candle {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** A tradable instrument as the provider knows it. */
export interface InstrumentInfo {
  /** Provider-scoped symbol, e.g. `AAPL` or `BTC/USDT`. */
  symbol: string
  /** Human-readable name, when the provider has one. */
  name?: string
  /** Free-form asset class tag, e.g. `equity`, `crypto`, `future`. */
  assetClass?: string
  /** Timeframes this provider can serve for the instrument. */
  timeframes?: Timeframe[]
}

/** A candle request. Ranges are ISO-8601 strings; both ends optional. */
export interface OhlcvQuery {
  symbol: string
  timeframe: Timeframe
  /** Inclusive range start (bar open time). Omit for "from the beginning". */
  start?: string
  /** Inclusive range end (bar open time). Omit for "to the latest". */
  end?: string
  /** Max bars returned, counted from the END of the range. */
  limit?: number
}

/**
 * The contract a data source implements. This is the whole BYO surface:
 * CSV files, ClickHouse, a broker API, and CCXT all look identical above
 * this line.
 */
export interface MarketDataProvider {
  /** Registry id, unique per running composition, e.g. `csv`, `ccxt`. */
  readonly id: string
  /** One line shown to users (and models) describing the data source. */
  readonly description: string
  /**
   * Optional discriminator: returns true if this provider claims handling for this symbol.
   * Enables automatic routing across heterogeneous providers (e.g. A-shares vs crypto vs Futu).
   */
  matchesSymbol?(symbol: string): boolean
  /** Enumerate available instruments. May be expensive; callers cache. */
  listSymbols(): Promise<InstrumentInfo[]>
  /**
   * Serve candles for one query, ascending by time, within [start, end],
   * trimmed to `limit` from the end. Unknown symbols/timeframes throw.
   */
  getOhlcv(query: OhlcvQuery): Promise<Candle[]>
  /** Perpetual-futures positioning for one symbol. Optional: spot/equity providers omit it. */
  getDerivatives?(symbol: string): Promise<Derivatives>
  /** Institutional & retail money flow (主力/散户资金流向). Optional: equity/crypto providers. */
  getMoneyFlow?(symbol: string): Promise<MoneyFlow>
  /** Level 2 depth orderbook (买卖盘口). Optional. */
  getOrderbook?(symbol: string): Promise<Orderbook>
  /** Fundamental financial metrics and valuations (基础财务估值). Optional. */
  getFundamentals?(symbol: string): Promise<FundamentalsPackage>
}

/** Single price-quantity level in an orderbook. */
export interface OrderbookLevel {
  price: number
  quantity: number
  orderCount?: number
}

/** Level 2 market depth orderbook snapshot. */
export interface Orderbook {
  symbol: string
  time: string
  bids: OrderbookLevel[]
  asks: OrderbookLevel[]
  midPrice?: number | undefined
  spread?: number | undefined
}

/** Individual executed trade tick. */
export interface TradeTick {
  time: string
  price: number
  quantity: number
  side: 'buy' | 'sell' | 'neutral'
}

/** Comprehensive financial fundamentals and valuation matrix. */
export interface FundamentalsPackage {
  symbol: string
  time?: string | undefined
  peTtm?: number | undefined
  peStatic?: number | undefined
  pb?: number | undefined
  dividendYieldPct?: number | undefined
  marketCap?: number | undefined
  circulatingMarketCap?: number | undefined
  turnoverRatio?: number | undefined
  roePct?: number | undefined
  netProfitGrowthPct?: number | undefined
  revenueGrowthPct?: number | undefined
  grossMarginPct?: number | undefined
  debtToAssetPct?: number | undefined
}

/** Normalized multi-market symbol representation. */
export interface NormalizedSymbol {
  raw: string
  canonical: string
  market: 'cn_stock' | 'hk_stock' | 'us_stock' | 'crypto' | 'future' | 'other'
  displayName: string
}

/** Institutional and retail order flow for equities or assets with volume tiering. */
export type MoneyFlow = {
  symbol: string
  time?: string
  /** Net total inflow in quote currency (e.g. CNY). Positive = inflow, negative = outflow. */
  netInflow: number
  /** Super-large institutional orders (超大单, 机构主力). */
  superLargeInflow?: number | null
  /** Large orders (大单). */
  largeInflow?: number | null
  /** Medium orders (中单). */
  mediumInflow?: number | null
  /** Small retail orders (小单, 散户). */
  smallInflow?: number | null
  /** Main money net ratio (% of total turnover, 主力净买占比). */
  mainRatioPct?: number | null
  /** Formatted overview summary line. */
  summary?: string
}

export interface DerivativeBar {
  time: string
  openInterest: number | null
  openInterestValue: number | null
  longShortRatio: number | null
  takerBuySellRatio: number | null
  topPositionRatio?: number | null
  topAccountRatio?: number | null
  posture?: string | null
}

/** A perpetual's positioning snapshot. A field is null when the venue did not serve it. */
export interface Derivatives {
  /** Venue the numbers came from, e.g. `Binance`, `Gate`. OI and ratios are per-venue. */
  source: string
  /** Open interest, in base units (e.g. ETH). */
  openInterest: number | null
  /** Open interest × mark price, in quote units (e.g. USDT). */
  openInterestValue: number | null
  /** Last settled funding rate as a fraction (0.0001 = 0.01%). */
  fundingRate: number | null
  /** Next funding settlement, ISO-8601 UTC. */
  nextFundingTime: string | null
  /** Global long/short ACCOUNT ratio (accounts, not size). */
  longShortRatio: number | null
  /** Top 20% margin traders by position size long/short ratio. */
  topPositionRatio?: number | null
  /** Top 20% margin traders by account count long/short ratio. */
  topAccountRatio?: number | null
  /** Taker buy volume / taker sell volume over the latest 5m window. */
  takerBuySellRatio: number | null
  /** Snapshot time, ISO-8601 UTC. */
  time: string
  /** 1-hour percentage change in open interest value. */
  oiChangePct1h?: number | null
  /** 1-hour percentage change in mark price. */
  priceChangePct1h?: number | null
  /** Smart money posture label: e.g. "主力做多 (多头增仓)", "主力开溜 (多头平仓)", "主力做空 (空头增仓)", "空头爆仓 (空头止损)". */
  posture?: string | null
  /** Retail crowd vs whale smart money divergence assessment. */
  crowdVsWhale?: string | null
  /** Historical derivative bars aligned with recent candles. */
  history?: DerivativeBar[]
}
