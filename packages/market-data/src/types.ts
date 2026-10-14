/**
 * The provider-facing vocabulary of the market-data seam. This module is
 * dependency-free on purpose: a provider implements these types and nothing
 * else, so bringing your own data never pulls in harness internals.
 * @module @dsh-trading/market-data
 */

/**
 * Supported bar intervals. Providers may serve a subset.
 *
 * `1M` is a calendar month. Binance's wire value is the capital `1M`; the
 * lowercase `1m` stays the one-minute bar, so the case is load-bearing.
 */
export type Timeframe =
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1h' | '2h' | '4h' | '6h' | '8h' | '12h'
  | '1d' | '3d' | '1w' | '1M'

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

/** One descriptive chip from a positioning series. Not a trade signal. */
export interface PositionReading {
  id: string
  label: string
  note: string
  tone: 'neutral' | 'warn'
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
  /** Ratio / taker readings for this bucket. Funding and basis are snapshot-only. */
  readings?: PositionReading[]
  /** Price × OI quadrant shown on the chart: 强多头 / 弱反弹 / 轧空 / 强空头 / 多头踩踏. */
  quadrant?: string | null
  quadrantNote?: string | null
}

/** A perpetual's positioning snapshot. A field is null when the venue did not serve it. */
export interface Derivatives {
  /** Venue the numbers came from, e.g. `Binance`, `OKX`, `Gate`. OI and ratios are per-venue — never mix units across venues silently. */
  source: string
  /** Open interest in **base coin** units (e.g. BTC). Use for Δ% so price alone cannot fake "平仓". */
  openInterest: number | null
  /** Open interest notional in **USDT** (base × mark). Prefer this for absolute display. */
  openInterestValue: number | null
  /** Unit tag for openInterest: always `base`. openInterestValue is always USDT notional. */
  oiUnit?: 'base'
  /** Last settled funding rate as a fraction (0.0001 = 0.01% per funding interval). */
  fundingRate: number | null
  /**
   * Annualized funding % assuming 8h interval: rate × 100 × 3 × 365.
   * Neutral reference on most venues ≈ +0.01%/8h ≈ +10.95%/yr — not a bullish call.
   */
  fundingRateAnnualizedPct?: number | null
  /** Human note for the funding print, e.g. `中性(≈0.01%/8h)`. */
  fundingLabel?: string | null
  /** Next funding settlement, ISO-8601 UTC. */
  nextFundingTime: string | null
  /**
   * Global long/short **account-count** ratio (Binance: globalLongShortAccountRatio).
   * >1 = more long accounts than short accounts — not size.
   */
  longShortRatio: number | null
  /** Explicit alias / display name for longShortRatio kind. */
  longShortRatioKind?: 'global_accounts' | 'top_accounts' | 'top_positions' | 'unknown'
  /** Top traders by **position size** long/short (Binance: topLongShortPositionRatio). */
  topPositionRatio?: number | null
  /** Top traders by **account count** long/short (Binance: topLongShortAccountRatio). */
  topAccountRatio?: number | null
  /** Taker buy volume / taker sell volume over the latest window. */
  takerBuySellRatio: number | null
  /** Cumulative taker buy−sell over ~1h (base units). CVD proxy, not a signal. */
  cvd1h?: number | null
  /** Brief CVD-vs-price note when both are available. */
  cvdNote?: string | null
  /** (mark − index) / index × 100. Positive = perp premium (升水). */
  basisPct?: number | null
  /** Snapshot time, ISO-8601 UTC. */
  time: string
  /** % change of base-unit OI over 1h / 4h / 24h. */
  oiChangePct1h?: number | null
  oiChangePct4h?: number | null
  oiChangePct24h?: number | null
  /** % change of implied mark (OI-value/OI) over 1h / 4h / 24h. */
  priceChangePct1h?: number | null
  priceChangePct4h?: number | null
  priceChangePct24h?: number | null
  /** Price × OI posture in base units, e.g. 价涨增仓(新多推动). */
  posture?: string | null
  quadrant?: string | null
  quadrantNote?: string | null
  crowdVsWhale?: string | null
  readings?: PositionReading[]
  history?: DerivativeBar[]
  /** Long liquidations notional (USDT) over ~1h. */
  liquidationLongUsd1h?: number | null
  /** Short liquidations notional (USDT) over ~1h. */
  liquidationShortUsd1h?: number | null
  liquidationSummary?: string | null
  /** Where liquidation numbers came from when it differs from `source` (e.g. Binance book + OKX liq). */
  liquidationSource?: string | null
}
