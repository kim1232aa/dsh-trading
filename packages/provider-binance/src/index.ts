/**
 * Binance public-klines provider. No API key, no dependencies beyond Node's
 * built-in fetch. Serves any USDT-quoted spot pair Binance lists.
 *
 * ponytail: one exchange, no WebSocket, no rate-limit retry. Add when needed.
 * @module @dsh-trading/provider-binance
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  Candle,
  DerivativeBar,
  Derivatives,
  InstrumentInfo,
  MarketDataProvider,
  OhlcvQuery,
  Timeframe,
} from '@dsh-trading/market-data'

export const name = 'provider-binance'
export const inject = ['marketData']

export interface Config {
  /** Symbols to advertise in list_symbols (Binance spot tickers, e.g. ETHUSDT). */
  symbols: string[]
  /** Binance REST base URL. */
  baseURL: string
  /** Binance USDⓈ-M futures REST base URL. */
  futuresURL: string
  /** Provider id for multi-provider setups. */
  id: string
}

export const Config: z<Config> = z.object({
  symbols: z.array(z.string()).default([
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT',
  ]),
  // Binance's public market-data mirror: same /api/v3/klines, reachable where api.binance.com is not.
  baseURL: z.string().default('https://data-api.binance.vision'),
  // USDⓈ-M perpetuals: open interest, funding, long/short. Public, no key.
  futuresURL: z.string().default('https://fapi.binance.com'),
  id: z.string().default('binance'),
}) as unknown as z<Config>

// Binance spot kline intervals, minus `1s` (sub-minute bars would flood the
// candle pane) and plus nothing Binance does not actually serve.
const TF_MAP: Record<Timeframe, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h',
  '1d': '1d', '3d': '3d', '1w': '1w', '1M': '1M',
}

const ALL_TIMEFRAMES: Timeframe[] = [
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M',
]

/** High-availability mirror hosts for Binance spot public klines. Includes official mirrors and domestic failover endpoints. */
const SPOT_KLINE_HOSTS = [
  'https://data-api.binance.vision',
  'https://www.usnbweb.red',
  'https://www.marketwebb.link',
  'https://api.binance.info',
  'https://api.binance.bz',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api3.binance.com',
]

const COMMON_QUOTES = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'BTC', 'ETH']

/**
 * Normalizes user-typed symbols:
 * - Trims whitespace and strips separators ('ETH/USDT', 'eth_usdt' -> 'ETHUSDT')
 * - Uppercases ('btc' -> 'BTCUSDT')
 * - Corrects USDT transpositions ('ETHUDST', 'ETHUSTD' -> 'ETHUSDT')
 * - Appends 'USDT' if base coin only ('ETH' -> 'ETHUSDT', 'BTC' -> 'BTCUSDT')
 */
export function normalizeSymbol(s: string): string {
  let res = s.trim().toUpperCase().replace(/[/_\-\s]/g, '')
  if (res.length > 3) {
    // Unambiguous USDT transpositions only. Bare USD is ambiguous (BNBUSD, BTCTUSD) and gets a hint, not a rewrite.
    res = res.replace(/(UDST|USTD|UTSD)$/, 'USDT')
  }
  // Only skip appending USDT if string is longer than the quote and ends with it (e.g. 'BNBETH', not bare 'ETH')
  if (res && !COMMON_QUOTES.some(q => res.length > q.length && res.endsWith(q))) {
    res += 'USDT'
  }
  return res
}

/**
 * Nearest listed symbol by edit distance (a swap like EHT→ETH costs 2), for the error hint only.
 * Never auto-corrected: silently charting a different instrument is worse than an error.
 */
export function closestSymbol(s: string, list: readonly string[]): string | null {
  const target = s.trim().toUpperCase().replace(/[/_\-\s]/g, '')
  const cleaned = target.length > 3 ? target.replace(/(UDST|USTD|UTSD|USD)$/, 'USDT') : target
  const withUsdt = cleaned.endsWith('USDT') ? cleaned : cleaned + 'USDT'
  let best: string | null = null
  let bestD = 3
  for (const c of list) {
    const d1 = levenshtein(cleaned, c)
    const d2 = levenshtein(withUsdt, c)
    const d = Math.min(d1, d2)
    if (d < bestD) { bestD = d; best = c }
  }
  return best
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]!
}

class BinanceProvider implements MarketDataProvider {
  readonly id: string
  readonly description: string

  constructor(
    id: string,
    private readonly symbols: string[],
    private readonly baseURL: string,
    private readonly futuresURL: string,
  ) {
    this.id = id
    this.description = `Binance public klines (${symbols.length} symbols)`
  }

  async listSymbols(): Promise<InstrumentInfo[]> {
    return this.symbols.map(symbol => ({ symbol, timeframes: [...ALL_TIMEFRAMES] }))
  }

  async getOhlcv(query: OhlcvQuery): Promise<Candle[]> {
    const interval = TF_MAP[query.timeframe]
    if (!interval) throw new Error(`unsupported timeframe: ${query.timeframe}`)

    const symbol = normalizeSymbol(query.symbol)
    const isCustomBase = this.baseURL && this.baseURL !== 'https://data-api.binance.vision'
    const hosts = isCustomBase ? [this.baseURL] : SPOT_KLINE_HOSTS

    let lastNetworkError: Error | null = null

    for (const host of hosts) {
      try {
        const url = new URL('/api/v3/klines', host)
        url.searchParams.set('symbol', symbol)
        url.searchParams.set('interval', interval)
        url.searchParams.set('limit', String(Math.min(query.limit ?? 200, 1000)))
        if (query.start) url.searchParams.set('startTime', String(Date.parse(query.start)))
        if (query.end) url.searchParams.set('endTime', String(Date.parse(query.end)))

        const res = await fetch(url, { signal: AbortSignal.timeout(6_000) })
        if (!res.ok) {
          const errText = await res.text().catch(() => '')
          const hint = errText.includes('-1121')
            ? (closestSymbol(query.symbol, this.symbols) ?? closestSymbol(symbol, this.symbols))
            : null
          throw new Error(`Binance ${res.status}: ${errText.includes('-1121') ? `Invalid symbol '${query.symbol}' (tried '${symbol}')${hint ? `，是不是 ${hint}？` : ''}` : errText}`)
        }

        const rows = (await res.json()) as unknown[][]
        return rows.map(r => ({
          time: new Date(r[0] as number).toISOString(),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5]),
        }))
      } catch (err: unknown) {
        const e = err as Error
        // Business validation / bad symbol error: do not retry other hosts
        if (e.message && e.message.includes('Invalid symbol')) {
          throw e
        }
        lastNetworkError = e
      }
    }

    const isFetchFailed = lastNetworkError?.name === 'TypeError' || lastNetworkError?.message?.includes('fetch failed')
    const isTimeout = lastNetworkError?.name === 'TimeoutError' || lastNetworkError?.message?.includes('timeout')
    const detail = isTimeout
      ? '连接行情接口超时 (6s)'
      : isFetchFailed
        ? '行情网络连接被阻断或重置 (ECONNRESET/TLS failure)'
        : lastNetworkError?.message || '网络连接异常'

    throw new Error(`[Binance行情不可达] ${detail}。若处于大陆网络，请检查代理配置或切换上方数据源至【东财/新浪A股】。`)
  }

  /** Until when fallback providers lead, after Binance futures failed. */
  private fallbackUntil = 0

  /**
   * Binance first, OKX as secondary fallback, Gate.io as tertiary:
   * fapi.binance.com is intermittently unreachable from some domestic networks
   * while OKX and Gate multi-domain CDNs provide high-availability failover.
   */
  async getDerivatives(rawSymbol: string): Promise<Derivatives> {
    const symbol = normalizeSymbol(rawSymbol)
    const binance = (): Promise<Derivatives> => this.binanceDerivatives(symbol)
    const okx = (): Promise<Derivatives> => okxDerivatives(symbol)
    const gate = (): Promise<Derivatives> => gateDerivatives(symbol)
    const order = Date.now() < this.fallbackUntil ? [okx, gate, binance] : [binance, okx, gate]
    let firstError: unknown
    for (const venue of order) {
      try {
        return await venue()
      } catch (e) {
        if (venue === binance && !String(e).includes('Binance futures ')) {
          this.fallbackUntil = Date.now() + 10 * 60_000
        }
        firstError ??= e
      }
    }
    throw firstError
  }

  /**
   * Four public futures endpoints in parallel. Each one degrades to null on its
   * own (the stats endpoints are the flakiest), so one bad leg never blanks the
   * others; a symbol with no perpetual at all throws.
   */
  private async binanceDerivatives(symbol: string): Promise<Derivatives> {
    const isDefault = !this.futuresURL || this.futuresURL === 'https://fapi.binance.com'
    const candidates = isDefault
      ? ['https://www.usnbweb.red', 'https://www.marketwebb.link', 'https://fapi.binance.com']
      : [this.futuresURL]
    let firstErr: unknown = null
    for (const host of candidates) {
      try {
        const get = async (path: string, extra: Record<string, string> = {}): Promise<unknown> => {
          const url = new URL(path, host)
          url.searchParams.set('symbol', symbol)
          for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v)
          const res = await fetch(url, { signal: AbortSignal.timeout(3_500) })
          if (!res.ok) throw new Error(`Binance futures ${res.status}: ${await res.text().catch(() => '')}`)
          return res.json()
        }
        const stat = { period: '5m', limit: '12' }
        const [premium, oi, oiHist, ls, topPos, topAcc, taker] = await Promise.allSettled([
          get('/fapi/v1/premiumIndex'),
          get('/fapi/v1/openInterest'),
          get('/futures/data/openInterestHist', stat),
          get('/futures/data/globalLongShortAccountRatio', stat),
          get('/futures/data/topLongShortPositionRatio', stat),
          get('/futures/data/topLongShortAccountRatio', stat),
          get('/futures/data/takerlongshortRatio', { period: '5m', limit: '1' }),
        ])
        if (premium.status === 'rejected') throw premium.reason
        const p = premium.value as { markPrice: string; lastFundingRate: string; nextFundingTime: number; time: number }
        const first = (r: PromiseSettledResult<unknown>): Record<string, unknown> | undefined =>
          r.status === 'fulfilled' && Array.isArray(r.value) ? r.value[0] as Record<string, unknown> | undefined : undefined
        const lastArr = (r: PromiseSettledResult<unknown>): Record<string, unknown> | undefined =>
          r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length > 0 ? r.value[r.value.length - 1] as Record<string, unknown> | undefined : undefined

        const openInterest = oi.status === 'fulfilled' ? num((oi.value as { openInterest?: string }).openInterest) : null
        const mark = num(p.markPrice)
        const openInterestValue = openInterest !== null && mark !== null ? openInterest * mark : null

        // Base-unit OI (ETH), not USD value: value moves with price, which would read a pure price drop as "平仓".
        const hist = (oiHist.status === 'fulfilled' && Array.isArray(oiHist.value) ? oiHist.value : []) as Record<string, unknown>[]
        const pastOi = num(hist[0]?.['sumOpenInterest'])
        const pastVal = num(hist[0]?.['sumOpenInterestValue'])
        const pastPrice = pastOi !== null && pastVal !== null && pastOi > 0 ? pastVal / pastOi : null
        const oiChangePct1h = openInterest !== null && pastOi !== null && pastOi > 0
          ? Number((((openInterest - pastOi) / pastOi) * 100).toFixed(2)) : null
        const priceChangePct1h = mark !== null && pastPrice !== null
          ? Number((((mark - pastPrice) / pastPrice) * 100).toFixed(2)) : null
        const posture = oiChangePct1h !== null && priceChangePct1h !== null
          ? postureOf(priceChangePct1h, oiChangePct1h, true) : null

        const history: DerivativeBar[] = hist.map((item, idx, arr) => {
          const itemVal = num(item['sumOpenInterestValue'])
          const itemOi = num(item['sumOpenInterest'])
          const prevItem = idx > 0 ? arr[idx - 1] : undefined
          const prevOi = prevItem ? num(prevItem['sumOpenInterest']) : null
          const prevVal = prevItem ? num(prevItem['sumOpenInterestValue']) : null
          let barPosture: string | null = null
          if (itemVal !== null && itemOi !== null && prevVal !== null && prevOi !== null && itemOi > 0 && prevOi > 0) {
            const px = itemVal / itemOi
            const prevPx = prevVal / prevOi
            barPosture = postureOf(100 * (px - prevPx) / prevPx, 100 * (itemOi - prevOi) / prevOi, false)
          }
          const itemTs = num(item['timestamp'])
          const lsItem = ls.status === 'fulfilled' && Array.isArray(ls.value) ? ls.value[idx] : undefined
          const tpItem = topPos.status === 'fulfilled' && Array.isArray(topPos.value) ? topPos.value[idx] : undefined
          const taItem = topAcc.status === 'fulfilled' && Array.isArray(topAcc.value) ? topAcc.value[idx] : undefined
          return {
            time: new Date(itemTs !== null ? itemTs : Date.now()).toISOString(),
            openInterest: itemOi,
            openInterestValue: itemVal,
            longShortRatio: lsItem ? num(lsItem['longShortRatio']) : null,
            topPositionRatio: tpItem ? num(tpItem['longShortRatio']) : null,
            topAccountRatio: taItem ? num(taItem['longShortRatio']) : null,
            takerBuySellRatio: null,
            posture: barPosture,
          }
        })

        const lsRatio = num(lastArr(ls)?.['longShortRatio'])
        const tpRatio = num(lastArr(topPos)?.['longShortRatio'])
        const crowdVsWhale = crowdVsWhaleOf(lsRatio, tpRatio)

        return {
          source: 'Binance',
          openInterest,
          openInterestValue,
          fundingRate: num(p.lastFundingRate),
          nextFundingTime: Number.isFinite(p.nextFundingTime) && p.nextFundingTime > 0
            ? new Date(p.nextFundingTime).toISOString()
            : null,
          longShortRatio: lsRatio,
          topPositionRatio: tpRatio,
          topAccountRatio: num(lastArr(topAcc)?.['longShortRatio']),
          takerBuySellRatio: num(first(taker)?.['buySellRatio']),
          time: new Date(Number.isFinite(p.time) ? p.time : Date.now()).toISOString(),
          oiChangePct1h,
          priceChangePct1h,
          posture,
          crowdVsWhale,
          history,
        }
      } catch (err) {
        firstErr ??= err
      }
    }
    throw firstErr
  }
}

function num(v: unknown): number | null {
  const n = Number(v)
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? null : n
}

/**
 * Price × OI quadrant, from percentage changes. OI is market-wide, so the label
 * says what the flow most likely was, never who ("主力") did it. Moves inside
 * the dead zone are noise and get no direction. `long` = the 1h headline
 * (wider dead zone); otherwise a single 5m bar.
 * ponytail: fixed dead zones; scale them by ATR if they misfire on quiet/volatile coins.
 */
export function postureOf(pricePct: number, oiPct: number, long: boolean): string {
  const [pz, oz] = long ? [0.1, 0.3] : [0.02, 0.05]
  if (Math.abs(oiPct) < oz) return '持仓持平'
  const oiUp = oiPct > 0
  if (Math.abs(pricePct) < pz) return oiUp ? '价平增仓' : '价平减仓'
  const [head, tail] = pricePct > 0
    ? oiUp ? ['价涨增仓', '多头增仓'] : ['价涨减仓', '空头回补']
    : oiUp ? ['价跌增仓', '空头增仓'] : ['价跌减仓', '多头平仓']
  return long ? `${head} (${tail}为主)` : tail
}

/**
 * Deduce retail vs whale positioning divergence:
 * - globalLongShortAccountRatio: 99% retail accounts. High ratio (>=2.0) = retail heavily long.
 * - topLongShortPositionRatio: Top 20% margin whales (real capital).
 * When retail is heavily long while whales are cautious/short, retail is caught as liquidity.
 */
export function crowdVsWhaleOf(globalRatio: number | null, topPosRatio: number | null): string | null {
  if (globalRatio === null || topPosRatio === null) return null
  if (globalRatio >= 2.0 && topPosRatio < 1.6) {
    return '散户极度接多(多73%+)，大户未跟偏空 (对手盘风险)'
  }
  if (globalRatio <= 0.8 && topPosRatio > 1.4) {
    return '散户恐慌割肉做空，大户逆势吸筹做多'
  }
  if (globalRatio >= 1.5 && topPosRatio >= 1.8) {
    return '大户散户共识做多'
  }
  if (globalRatio <= 0.8 && topPosRatio <= 1.0) {
    return '大户散户共识做空'
  }
  return null
}

const GATE_URL = 'https://api.gateio.ws'

/**
 * Gate.io USDT perpetual (ETHUSDT → ETH_USDT). Gate's own book, so OI and
 * ratios are Gate's, not Binance's — the strip names its source for that reason.
 */
async function gateDerivatives(rawSymbol: string): Promise<Derivatives> {
  const symbol = normalizeSymbol(rawSymbol)
  const contract = encodeURIComponent(symbol.replace(/USDT$/, '_USDT'))
  if (!contract.endsWith('_USDT')) throw new Error(`Gate: no USDT perpetual for ${symbol}`)
  const get = async (path: string): Promise<unknown> => {
    const res = await fetch(new URL(path, GATE_URL), { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) throw new Error(`Gate futures ${res.status}: ${await res.text().catch(() => '')}`)
    return res.json()
  }
  const [c, stats] = await Promise.all([
    get(`/api/v4/futures/usdt/contracts/${contract}`) as Promise<Record<string, unknown>>,
    get(`/api/v4/futures/usdt/contract_stats?contract=${contract}&interval=5m&limit=120`) as Promise<Record<string, unknown>[]>,
  ])
  const s = stats.at(-1) ?? {}
  // 120 bars of 5m = 10h. 1h ago is 12 bars back (index length - 13).
  const past1h = stats.length > 12 ? (stats[stats.length - 13] ?? stats[0] ?? {}) : (stats[0] ?? {})
  const multiplier = num(c['quanto_multiplier'])
  const contracts = num(s['open_interest'])
  const next = num(c['funding_next_apply'])
  const time = num(s['time'])

  const currentOIUsd = num(s['open_interest_usd'])
  const pastOIUsd = num(past1h['open_interest_usd'])
  const currentPrice = num(c['mark_price']) ?? num(s['mark_price'])
  const pastPrice = num(past1h['mark_price'])

  let oiChangePct1h: number | null = null
  let priceChangePct1h: number | null = null
  // Contracts, not USD: USD OI moves with price and would read a pure price drop as 平仓.
  const pastContracts = num(past1h['open_interest'])
  if (contracts !== null && pastContracts !== null && pastContracts > 0) {
    oiChangePct1h = Number((((contracts - pastContracts) / pastContracts) * 100).toFixed(2))
  }
  if (currentPrice !== null && pastPrice !== null && pastPrice > 0) {
    priceChangePct1h = Number((((currentPrice - pastPrice) / pastPrice) * 100).toFixed(2))
  }

  const posture = oiChangePct1h !== null && priceChangePct1h !== null
    ? postureOf(priceChangePct1h, oiChangePct1h, true) : null

  const history: DerivativeBar[] = stats.map((item, idx) => {
    const itemContracts = num(item['open_interest'])
    const itemOi = itemContracts !== null && multiplier !== null ? itemContracts * multiplier : null
    const itemOiUsd = num(item['open_interest_usd'])
    const itemPrice = num(item['mark_price'])
    const prevItem = idx > 0 ? stats[idx - 1] : undefined
    const prevP = prevItem ? num(prevItem['mark_price']) : null
    const prevO = prevItem ? num(prevItem['open_interest_usd']) : null
    let barPosture: string | null = null
    // Contracts, not USD: USD OI moves with price.
    const prevC = prevItem ? num(prevItem['open_interest']) : null
    if (itemPrice !== null && prevP !== null && itemContracts !== null && prevC !== null && prevC > 0 && prevP > 0) {
      barPosture = postureOf(100 * (itemPrice - prevP) / prevP, 100 * (itemContracts - prevC) / prevC, false)
    }
    const itemTime = num(item['time'])
    return {
      time: new Date((itemTime !== null ? itemTime : Date.now() / 1000) * 1000).toISOString(),
      openInterest: itemOi,
      openInterestValue: itemOiUsd,
      longShortRatio: num(item['lsr_account']),
      takerBuySellRatio: num(item['lsr_taker']),
      posture: barPosture,
    }
  })

  return {
    source: 'Gate',
    openInterest: contracts !== null && multiplier !== null ? contracts * multiplier : null,
    openInterestValue: currentOIUsd,
    fundingRate: num(c['funding_rate']),
    nextFundingTime: next !== null && next > 0 ? new Date(next * 1000).toISOString() : null,
    longShortRatio: num(s['lsr_account']),
    takerBuySellRatio: num(s['lsr_taker']),
    time: new Date(time !== null ? time * 1000 : Date.now()).toISOString(),
    oiChangePct1h,
    priceChangePct1h,
    posture,
    history,
  }
}

const OKX_DOMAINS = [
  'https://www.btmrvkxwhpn.com',
  'https://www.ouyi.fit',
  'https://aws.okx.com',
  'https://www.okx.com',
]

async function okxGet(path: string, params?: Record<string, string>): Promise<unknown> {
  let firstErr: unknown
  for (const domain of OKX_DOMAINS) {
    try {
      const url = new URL(path, domain)
      if (params) {
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
      }
      const res = await fetch(url, { signal: AbortSignal.timeout(4_000) })
      if (!res.ok) continue
      const json = await res.json() as { code?: string | number; data?: unknown }
      if (json.code === '0' || json.code === 0) return json.data
    } catch (e) {
      firstErr ??= e
    }
  }
  throw firstErr ?? new Error(`All OKX endpoints unreachable for ${path}`)
}

/**
 * OKX perpetual futures (ETHUSDT -> ETH-USDT-SWAP).
 * Multi-domain resilient with live open interest, funding rate, top positions, and taker volume.
 */
export async function okxDerivatives(rawSymbol: string): Promise<Derivatives> {
  const symbol = normalizeSymbol(rawSymbol)
  const base = symbol.replace(/(USDT|USDC)$/, '')
  const quote = symbol.endsWith('USDC') ? 'USDC' : 'USDT'
  const instId = `${base}-${quote}-SWAP`

  // Each leg degrades to null alone; no OI at all means OKX is unusable, so getDerivatives falls through to Gate.
  const [fundingData, oiData, oihData, topData, takerData] = await Promise.all([
    okxGet('/api/v5/public/funding-rate', { instId }).catch(() => null),
    okxGet('/api/v5/public/open-interest', { instType: 'SWAP', instId }).catch(() => null),
    okxGet('/api/v5/rubik/stat/contracts/open-interest-history', { instId, period: '5m' }).catch(() => null),
    okxGet('/api/v5/rubik/stat/contracts/long-short-position-ratio-contract-top-trader', { instId, period: '5m' }).catch(() => null),
    okxGet('/api/v5/rubik/stat/taker-volume-contract', { instId, period: '5m', unit: '1' }).catch(() => null),
  ])
  if (!Array.isArray(oiData) || oiData.length === 0) throw new Error(`OKX open interest unavailable for ${instId}`)

  const f = (fundingData as Array<Record<string, unknown>> | null)?.[0] ?? {}
  const o = (oiData as Array<Record<string, unknown>>)[0]!
  // Newest first: [ts, oi(contracts), oiCcy(base units), oiUsd]
  const oih = (oihData as Array<[string, string, string, string]> | null) ?? []
  const top = (topData as Array<[string, string]> | null) ?? []
  // Newest first: [ts, sellVol, buyVol]
  const taker = (takerData as Array<[string, string, string]> | null) ?? []

  const oi = num(o['oiCcy']) ?? num(o['oi'])
  const oiUsd = num(o['oiUsd'])
  const fundingRate = num(f['fundingRate'])
  const nextFundingTime = f['nextFundingTime'] ? new Date(Number(f['nextFundingTime'])).toISOString() : null
  const time = o['ts'] ? new Date(Number(o['ts'])).toISOString() : new Date().toISOString()

  // Base-unit OI and its implied price (oiUsd / oiCcy), so posture is the same price x OI quadrant Binance/Gate use.
  const pt = (row: [string, string, string, string] | undefined): { oi: number | null; px: number | null } => {
    const ccy = num(row?.[2])
    const usd = num(row?.[3])
    return { oi: ccy, px: ccy !== null && usd !== null && ccy > 0 ? usd / ccy : null }
  }
  const chg = (a: number | null, b: number | null): number | null => (a !== null && b !== null && b > 0 ? ((a - b) / b) * 100 : null)
  const round2 = (v: number | null): number | null => (v === null ? null : Number(v.toFixed(2)))
  const now = pt(oih[0])
  const ago = pt(oih[12] ?? oih[oih.length - 1])
  const oiChangePct1h = round2(chg(now.oi, ago.oi))
  const priceChangePct1h = round2(chg(now.px, ago.px))
  const posture = oiChangePct1h !== null && priceChangePct1h !== null ? postureOf(priceChangePct1h, oiChangePct1h, true) : null

  const topPositionRatio = num(top[0]?.[1])
  const sell = num(taker[0]?.[1])
  const buy = num(taker[0]?.[2])
  const takerBuySellRatio = buy !== null && sell !== null && sell > 0 ? Number((buy / sell).toFixed(4)) : null
  // No all-accounts (retail) ratio fetched from OKX, so no retail-vs-whale read.
  const crowdVsWhale = null

  const history: DerivativeBar[] = [...oih].reverse().map((row, i, asc) => {
    const cur = pt(row)
    const prev = i > 0 ? pt(asc[i - 1]) : null
    const dOi = prev ? chg(cur.oi, prev.oi) : null
    const dPx = prev ? chg(cur.px, prev.px) : null
    return {
      time: new Date(num(row[0]) ?? Date.now()).toISOString(),
      openInterest: cur.oi,
      openInterestValue: num(row[3]),
      longShortRatio: null,
      takerBuySellRatio: null,
      topPositionRatio: null,
      posture: dOi !== null && dPx !== null ? postureOf(dPx, dOi, false) : null,
    }
  })

  return {
    source: 'OKX',
    openInterest: oi,
    openInterestValue: oiUsd,
    fundingRate,
    nextFundingTime,
    longShortRatio: null,
    topPositionRatio,
    takerBuySellRatio,
    crowdVsWhale,
    time,
    oiChangePct1h,
    priceChangePct1h,
    posture,
    history,
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.marketData.register(
    new BinanceProvider(config.id ?? 'binance', config.symbols, config.baseURL, config.futuresURL ?? 'https://fapi.binance.com'),
  ))
}
