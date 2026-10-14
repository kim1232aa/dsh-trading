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
import { formatUsdtCn } from '@dsh-trading/market-data'

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
  /**
   * Also register an `okx` provider (spot klines + SWAP derivatives including
   * liquidations). Default true — crypto desks want Binance + OKX side by side.
   */
  registerOkx: boolean
  /** Catalogue for the OKX provider (same tickers, OKX notation under the hood). */
  okxSymbols: string[]
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
  registerOkx: z.boolean().default(true),
  okxSymbols: z.array(z.string()).default([
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT',
  ]),
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

/**
 * True for symbols this provider should claim under resolveProvider.
 * Must NOT claim A-share codes: normalizeSymbol("600519") would become
 * "600519USDT", so we refuse 6-digit / SH|SZ|BJ forms up front.
 */
export function isBinanceSymbol(raw: string): boolean {
  const original = raw.trim().toUpperCase()
  // Futu-style prefixes (checked before stripping dots).
  if (/^(HK|US|SH|SZ|CC)\./.test(original)) return false
  const s = original.replace(/[/_\-\s]/g, '')
  if (!s) return false
  if (/^\d{6}$/.test(s)) return false
  if (/^(SH|SZ|BJ)\d{6}$/.test(s) || /^\d{6}(SH|SZ|BJ)$/.test(s)) return false
  // Only claim symbols that already carry a known quote. Bare "ETH" / "DEMO-EQ"
  // must not steal routing from csv or other providers (DEMO-EQ → DEMOEQ).
  return COMMON_QUOTES.some(q => s.length > q.length && s.endsWith(q))
}

export class BinanceProvider implements MarketDataProvider {
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

  matchesSymbol(symbol: string): boolean {
    return isBinanceSymbol(symbol)
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

    // High availability failover: when Binance hosts are blocked or unreachable in mainland China,
    // seamlessly fall back to domestic-resilient Gate.io and OKX spot candlesticks.
    try {
      return await gateSpotCandles(query.symbol, query.timeframe, query.limit)
    } catch {
      try {
        return await okxSpotCandles(query.symbol, query.timeframe, query.limit)
      } catch {
        // Fall through to error reporting below if all fallback venues fail
      }
    }

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
      ? ['https://www.usnbweb.red', 'https://www.binance.com', 'https://fapi.binance.com']
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
        // 300×5m ≈ 25h so Δ1h/4h/24h are real anchors, not hist[0] masquerading as 1h.
        const oiStat = { period: '5m', limit: '300' }
        const stat = { period: '5m', limit: '120' }
        const [premium, oi, oiHist, ls, topPos, topAcc, taker] = await Promise.allSettled([
          get('/fapi/v1/premiumIndex'),
          get('/fapi/v1/openInterest'),
          get('/futures/data/openInterestHist', oiStat),
          get('/futures/data/globalLongShortAccountRatio', stat),
          get('/futures/data/topLongShortPositionRatio', stat),
          get('/futures/data/topLongShortAccountRatio', stat),
          get('/futures/data/takerlongshortRatio', stat),
        ])
        if (premium.status === 'rejected') throw premium.reason
        const p = premium.value as { markPrice: string; indexPrice?: string; lastFundingRate: string; nextFundingTime: number; time: number }
        const first = (r: PromiseSettledResult<unknown>): Record<string, unknown> | undefined =>
          r.status === 'fulfilled' && Array.isArray(r.value) ? r.value[0] as Record<string, unknown> | undefined : undefined
        const lastArr = (r: PromiseSettledResult<unknown>): Record<string, unknown> | undefined =>
          r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length > 0 ? r.value[r.value.length - 1] as Record<string, unknown> | undefined : undefined

        const openInterest = oi.status === 'fulfilled' ? num((oi.value as { openInterest?: string }).openInterest) : null
        const mark = num(p.markPrice)
        const openInterestValue = openInterest !== null && mark !== null ? openInterest * mark : null

        // Base-unit OI for Δ%: USDT notional moves with price and would fake "平仓".
        const hist = (oiHist.status === 'fulfilled' && Array.isArray(oiHist.value) ? oiHist.value : []) as Record<string, unknown>[]
        const nowMs = Number.isFinite(p.time) ? p.time : Date.now()
        const horizon = (lookbackMs: number): { oiPct: number | null; pxPct: number | null } => {
          const past = sampleAtOrBefore(hist, nowMs, lookbackMs)
          const pastOi = num(past?.['sumOpenInterest'])
          const pastVal = num(past?.['sumOpenInterestValue'])
          const pastPrice = pastOi !== null && pastVal !== null && pastOi > 0 ? pastVal / pastOi : null
          return {
            oiPct: pctChange(openInterest, pastOi),
            pxPct: pctChange(mark, pastPrice),
          }
        }
        const h1 = horizon(60 * 60 * 1000)
        const h4 = horizon(4 * 60 * 60 * 1000)
        const h24 = horizon(24 * 60 * 60 * 1000)
        const oiChangePct1h = h1.oiPct
        const oiChangePct4h = h4.oiPct
        const oiChangePct24h = h24.oiPct
        const priceChangePct1h = h1.pxPct
        const priceChangePct4h = h4.pxPct
        const priceChangePct24h = h24.pxPct

        const lsRatio = num(lastArr(ls)?.['longShortRatio'])
        const tpRatio = num(lastArr(topPos)?.['longShortRatio'])
        const taRatio = num(lastArr(topAcc)?.['longShortRatio'])
        const crowdVsWhale = crowdVsWhaleOf(lsRatio, tpRatio)
        const latestTakerRatio = num(lastArr(taker)?.['buySellRatio']) ?? num(first(taker)?.['buySellRatio'])
        const takerRows = (taker.status === 'fulfilled' && Array.isArray(taker.value) ? taker.value : []) as Record<string, unknown>[]
        const cvd1h = cvdFromTakerRows(takerRows, nowMs)
        const cvdNote = cvdNoteOf(cvd1h, priceChangePct1h)
        const basis = basisPct(mark, num(p.indexPrice))
        const fundingRate = num(p.lastFundingRate)
        const readings = positionReadings({
          longShortRatio: lsRatio,
          topPositionRatio: tpRatio,
          topAccountRatio: taRatio,
          takerBuySellRatio: latestTakerRatio,
          fundingRate,
          basisPct: basis,
        })
        const posture = oiChangePct1h !== null && priceChangePct1h !== null
          ? postureOf(priceChangePct1h, oiChangePct1h, true, {
            takerRatio: latestTakerRatio,
            fundingRate,
            crowdVsWhale,
          }) : null
        const quadrant = quadrantFields(priceChangePct1h, oiChangePct1h, true)

        const history: DerivativeBar[] = hist.map((item, idx, arr) => {
          const itemVal = num(item['sumOpenInterestValue'])
          const itemOi = num(item['sumOpenInterest'])
          const prevItem = idx > 0 ? arr[idx - 1] : undefined
          const prevOi = prevItem ? num(prevItem['sumOpenInterest']) : null
          const prevVal = prevItem ? num(prevItem['sumOpenInterestValue']) : null
          const itemTs = num(item['timestamp'])
          const lsRows = ls.status === 'fulfilled' && Array.isArray(ls.value) ? ls.value as Record<string, unknown>[] : undefined
          const tpRows = topPos.status === 'fulfilled' && Array.isArray(topPos.value) ? topPos.value as Record<string, unknown>[] : undefined
          const taRows = topAcc.status === 'fulfilled' && Array.isArray(topAcc.value) ? topAcc.value as Record<string, unknown>[] : undefined
          const tkRows = taker.status === 'fulfilled' && Array.isArray(taker.value) ? taker.value as Record<string, unknown>[] : undefined
          const lsItem = itemTs !== null ? rowNear(lsRows, itemTs) : undefined
          const tpItem = itemTs !== null ? rowNear(tpRows, itemTs) : undefined
          const taItem = itemTs !== null ? rowNear(taRows, itemTs) : undefined
          const tkItem = itemTs !== null ? rowNear(tkRows, itemTs) : undefined
          const barTakerRatio = tkItem ? num(tkItem['buySellRatio']) : null

          let barPosture: string | null = null
          let barQuadrant: { quadrant: string | null; quadrantNote: string | null } = { quadrant: null, quadrantNote: null }
          if (itemVal !== null && itemOi !== null && prevVal !== null && prevOi !== null && itemOi > 0 && prevOi > 0) {
            const px = itemVal / itemOi
            const prevPx = prevVal / prevOi
            const dPx = 100 * (px - prevPx) / prevPx
            const dOi = 100 * (itemOi - prevOi) / prevOi
            barPosture = postureOf(dPx, dOi, false, {
              takerRatio: barTakerRatio,
              fundingRate: num(p.lastFundingRate),
            })
            barQuadrant = quadrantFields(dPx, dOi, false)
          }
          return {
            time: new Date(itemTs !== null ? itemTs : Date.now()).toISOString(),
            openInterest: itemOi,
            openInterestValue: itemVal,
            longShortRatio: lsItem ? num(lsItem['longShortRatio']) : null,
            topPositionRatio: tpItem ? num(tpItem['longShortRatio']) : null,
            topAccountRatio: taItem ? num(taItem['longShortRatio']) : null,
            takerBuySellRatio: barTakerRatio,
            posture: barPosture,
            quadrant: barQuadrant.quadrant,
            quadrantNote: barQuadrant.quadrantNote,
            readings: positionReadings({
              longShortRatio: lsItem ? num(lsItem['longShortRatio']) : null,
              topPositionRatio: tpItem ? num(tpItem['longShortRatio']) : null,
              topAccountRatio: taItem ? num(taItem['longShortRatio']) : null,
              takerBuySellRatio: barTakerRatio,
            }),
          }
        })

        // Binance public REST has no free forceOrders; label OKX 1h liq as cross-venue reference when available.
        let liquidationLongUsd1h: number | null = null
        let liquidationShortUsd1h: number | null = null
        let liquidationSummary: string | null = null
        let liquidationSource: string | null = null
        try {
          const liq = await okxLiquidations1h(symbol)
          liquidationLongUsd1h = liq.longUsd
          liquidationShortUsd1h = liq.shortUsd
          liquidationSummary = liq.summary.replace('近1h爆仓', '近1h爆仓(参OKX)')
          liquidationSource = 'OKX'
        } catch { /* best-effort */ }

        return {
          source: 'Binance',
          openInterest,
          openInterestValue,
          oiUnit: 'base',
          fundingRate,
          fundingRateAnnualizedPct: fundingAnnualizedPct(fundingRate),
          fundingLabel: fundingRate !== null ? fundingLabelOf(fundingRate) : null,
          nextFundingTime: Number.isFinite(p.nextFundingTime) && p.nextFundingTime > 0
            ? new Date(p.nextFundingTime).toISOString()
            : null,
          longShortRatio: lsRatio,
          longShortRatioKind: 'global_accounts',
          topPositionRatio: tpRatio,
          topAccountRatio: taRatio,
          takerBuySellRatio: latestTakerRatio,
          cvd1h,
          cvdNote,
          basisPct: basis,
          time: new Date(Number.isFinite(p.time) ? p.time : Date.now()).toISOString(),
          oiChangePct1h,
          oiChangePct4h,
          oiChangePct24h,
          priceChangePct1h,
          priceChangePct4h,
          priceChangePct24h,
          posture,
          quadrant: quadrant.quadrant,
          quadrantNote: quadrant.quadrantNote,
          crowdVsWhale,
          readings,
          history,
          liquidationLongUsd1h,
          liquidationShortUsd1h,
          liquidationSummary,
          liquidationSource,
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
 * Latest row at or before `nowMs - lookbackMs`.
 * Returns null when that row is more than `slackMs` earlier, so a short series cannot be labeled as the requested window.
 */
export function sampleAtOrBefore(
  rows: readonly Record<string, unknown>[],
  nowMs: number,
  lookbackMs: number,
  slackMs = 15 * 60 * 1000,
): Record<string, unknown> | null {
  const target = nowMs - lookbackMs
  let best: Record<string, unknown> | null = null
  let bestTs = -Infinity
  for (const row of rows) {
    const ts = num(row['timestamp'])
    if (ts === null || ts > target) continue
    if (ts > bestTs) {
      best = row
      bestTs = ts
    }
  }
  if (best === null || target - bestTs > slackMs) return null
  return best
}

/** Match a stats row by timestamp. Index alignment is wrong when the endpoints return different lengths. */
function rowNear(
  rows: readonly Record<string, unknown>[] | undefined,
  ts: number,
  slackMs = 150_000,
): Record<string, unknown> | undefined {
  if (!rows) return undefined
  let best: Record<string, unknown> | undefined
  let bestDiff = slackMs + 1
  for (const row of rows) {
    const t = num(row['timestamp'])
    if (t === null) continue
    const d = Math.abs(t - ts)
    if (d < bestDiff) {
      best = row
      bestDiff = d
    }
  }
  return bestDiff <= slackMs ? best : undefined
}

export interface PostureFactors {
  takerRatio?: number | null | undefined
  fundingRate?: number | null | undefined
  crowdVsWhale?: string | null | undefined
  topPosRatio?: number | null | undefined
}

/**
 * Multi-factor Price × OI posture evaluation:
 * - Basic quadrant: pricePct vs oiPct (with dead-zone filtering)
 * - Taker volume aggression flow (aggressor confirmation / divergence)
 * - Extreme funding rate leverage congestion flags
 * - Retail vs whale counterparty risk
 */
/** The four labels the chart shows. Null while price or OI is still inside the dead zone. */
export function quadrantOf(pricePct: number, oiPct: number, long: boolean): string | null {
  const [pz, oz] = long ? [0.1, 0.3] : [0.02, 0.05]
  if (Math.abs(oiPct) < oz || Math.abs(pricePct) < pz) return null
  if (pricePct > 0) return oiPct > 0 ? '强多头' : '弱反弹 / 轧空'
  return oiPct > 0 ? '强空头' : '多头踩踏'
}

export function quadrantNote(label: string): string | null {
  switch (label) {
    case '强多头': return '多头真金白银主动开仓推高，趋势健康'
    case '弱反弹 / 轧空': return '空头止损平仓推动，容易衰竭'
    case '强空头': return '空头主动大举增仓砸盘，下跌动能足'
    case '多头踩踏': return '多头爆仓或割肉平仓，属于杀多行情'
    default: return null
  }
}

function quadrantFields(pricePct: number | null, oiPct: number | null, long: boolean): { quadrant: string | null; quadrantNote: string | null } {
  if (pricePct === null || oiPct === null) return { quadrant: null, quadrantNote: null }
  const quadrant = quadrantOf(pricePct, oiPct, long)
  return { quadrant, quadrantNote: quadrant === null ? null : quadrantNote(quadrant) }
}

export function postureOf(pricePct: number, oiPct: number, long: boolean, factors?: PostureFactors): string {
  const [pz, oz] = long ? [0.1, 0.3] : [0.02, 0.05]
  if (Math.abs(oiPct) < oz) return '持仓持平'
  const oiUp = oiPct > 0
  if (Math.abs(pricePct) < pz) return oiUp ? '价平增仓' : '价平减仓'

  const tk = factors?.takerRatio
  let head = ''
  let tail = ''

  if (pricePct > 0) {
    head = oiUp ? '价涨增仓' : '价涨减仓'
    if (oiUp) {
      tail = tk && tk >= 1.12 ? '多头主动吃单' : tk && tk <= 0.88 ? '多头被动推高' : '新仓推动'
    } else {
      tail = factors && pricePct > 2.0 ? '空头爆仓轧空' : '空头回补'
    }
  } else {
    head = oiUp ? '价跌增仓' : '价跌减仓'
    if (oiUp) {
      tail = tk && tk <= 0.88 ? '空头主动砸盘' : tk && tk >= 1.12 ? '大户接盘(人数追空)' : '空头增仓'
    } else {
      tail = factors && pricePct < -2.0 ? '多头踩踏' : '多头平仓'
    }
  }

  let result = long ? `${head} (${tail}为主)` : tail
  const fr = factors?.fundingRate
  if (long && fr !== null && fr !== undefined) {
    if (fr >= 0.0003) result += ' [费率多头拥挤]'
    else if (fr <= -0.0002) result += ' [费率空头拥挤]'
  }
  return result
}

/**
 * Account ratio counts heads. Position ratio counts size of the top 20% by margin.
 * Binance long/short ratio > 1 is net long. The same 1.15 / 0.87 cuts as positionReadings
 * decide 偏多 / 偏空. A still-long whale ratio is not short, even if it is below 1.6.
 */
export function crowdVsWhaleOf(globalRatio: number | null, topPosRatio: number | null): string | null {
  if (globalRatio === null || topPosRatio === null) return null
  if (!Number.isFinite(globalRatio) || !Number.isFinite(topPosRatio) || globalRatio < 0 || topPosRatio < 0) return null
  const whaleShort = topPosRatio <= 0.87
  const whaleLong = topPosRatio >= 1.15
  const retailShort = globalRatio <= 0.87
  if (globalRatio >= 2 && whaleShort) {
    const longPct = Math.round((globalRatio / (1 + globalRatio)) * 100)
    return `人数多头${longPct}%·大户仓偏空`
  }
  if (retailShort && whaleLong) return '人数偏空·大户仓偏多'
  if (globalRatio >= 1.5 && topPosRatio >= 1.8) return '人数与大户仓同向偏多'
  if (retailShort && whaleShort) return '人数与大户仓同向偏空'
  return null
}

export interface PositionReading {
  id: string
  label: string
  note: string
  tone: 'neutral' | 'warn'
}


/** % change a→b relative to b. Null when either side missing or b≤0. */
export function pctChange(now: number | null, past: number | null): number | null {
  if (now === null || past === null || !(past > 0) || !Number.isFinite(now) || !Number.isFinite(past)) return null
  return Number((((now - past) / past) * 100).toFixed(2))
}

/**
 * Annualize an 8h funding rate to percent: rate × 100 × 3 × 365.
 * Most USDT perps settle every 8h; venues with other intervals need a different multiplier.
 */
export function fundingAnnualizedPct(rate: number | null | undefined): number | null {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return null
  return Number((rate * 100 * 3 * 365).toFixed(2))
}

/**
 * Honest funding chip. Venue-default +0.01%/8h (0.0001) is **中性**, not 偏多.
 * Bands: ≥0.03% 多头拥挤 · >0.015% 偏多 · ≤−0.02% 空头拥挤 · <−0.005% 偏空 · else 中性.
 */
export function fundingLabelOf(rate: number): string {
  if (rate >= 0.0003) return '多头拥挤'
  if (rate > 0.00015) return '偏多'
  if (rate <= -0.0002) return '空头拥挤'
  if (rate < -0.00005) return '偏空'
  return '中性≈0.01%/8h'
}

/** Cumulative taker buy−sell over rows whose timestamp is within lookback of nowMs. */
export function cvdFromTakerRows(
  rows: readonly Record<string, unknown>[],
  nowMs: number,
  lookbackMs = 60 * 60 * 1000,
): number | null {
  const cutoff = nowMs - lookbackMs
  let sum = 0
  let n = 0
  for (const row of rows) {
    const ts = num(row['timestamp'] ?? row['ts'])
    if (ts === null || ts < cutoff) continue
    const buy = num(row['buyVol'])
    const sell = num(row['sellVol'])
    if (buy === null || sell === null) continue
    sum += buy - sell
    n += 1
  }
  return n === 0 ? null : Number(sum.toFixed(4))
}

/** Brief CVD vs price note — descriptive only, not a signal. */
export function cvdNoteOf(cvd: number | null, priceChangePct: number | null): string | null {
  if (cvd === null || priceChangePct === null) return null
  if (Math.abs(cvd) < 1e-9) return 'CVD≈0'
  const buyHeavy = cvd > 0
  if (buyHeavy && priceChangePct < -0.1) return 'CVD↑价↓背离'
  if (!buyHeavy && priceChangePct > 0.1) return 'CVD↓价↑背离'
  if (buyHeavy && priceChangePct > 0.1) return 'CVD价同向'
  if (!buyHeavy && priceChangePct < -0.1) return 'CVD价同向'
  return buyHeavy ? 'CVD偏买' : 'CVD偏卖'
}

/** (mark − index) / index, in percent. Null when either price is missing. */
export function basisPct(mark: number | null, index: number | null): number | null {
  if (mark === null || index === null || !(index > 0)) return null
  return Number((((mark - index) / index) * 100).toFixed(4))
}

/**
 * Descriptive chips for the series Binance actually returns. Not a direction call.
 * Account ratios count accounts, not size. Taker is this bucket's aggressor flow.
 * Funding and basis are omitted when absent, so a 5m history bar does not inherit the live snapshot.
 */
export function positionReadings(input: {
  longShortRatio?: number | null
  topPositionRatio?: number | null
  topAccountRatio?: number | null
  takerBuySellRatio?: number | null
  fundingRate?: number | null
  basisPct?: number | null
}): PositionReading[] {
  const out: PositionReading[] = []
  const accounts = input.longShortRatio
  const positions = input.topPositionRatio
  const topAccounts = input.topAccountRatio
  if (accounts !== null && accounts !== undefined && Number.isFinite(accounts)) {
    out.push({
      id: 'accounts',
      label: ratioWord(accounts, 1.15, 0.87, '人数偏多', '人数均衡', '人数偏空'),
      note: '全市场账户数多空比，>1净多账户；非持仓量。',
      tone: 'neutral',
    })
  }
  if (positions !== null && positions !== undefined && Number.isFinite(positions)) {
    out.push({
      id: 'top-positions',
      label: ratioWord(positions, 1.15, 0.87, '大户仓偏多', '大户仓均衡', '大户仓偏空'),
      note: '大户持仓量多空比，>1净多仓；非账户数。',
      tone: 'neutral',
    })
  }
  if (topAccounts !== null && topAccounts !== undefined && Number.isFinite(topAccounts)) {
    out.push({
      id: 'top-accounts',
      label: ratioWord(topAccounts, 1.15, 0.87, '大户户偏多', '大户户均衡', '大户户偏空'),
      note: '大户账户数比；与持仓比背离时更大仓在另一侧。',
      tone: 'neutral',
    })
  }
  if (accounts !== null && accounts !== undefined && positions !== null && positions !== undefined) {
    if (accounts >= 1.15 && positions <= 0.87) {
      out.push({ id: 'crowd-vs-size', label: '人数多·大户仓空', note: '账户数偏多但大户仓偏空；人数≠资金。', tone: 'warn' })
    } else if (accounts <= 0.87 && positions >= 1.15) {
      out.push({ id: 'crowd-vs-size', label: '人数空·大户仓多', note: '账户数偏空但大户仓偏多。', tone: 'warn' })
    }
  }
  if (topAccounts !== null && topAccounts !== undefined && positions !== null && positions !== undefined) {
    if (topAccounts >= 1.15 && positions <= 0.87) {
      out.push({ id: 'whale-split', label: '头部仓位在空', note: '大户账户数偏多，但大户持仓量偏空。更大的仓在空头。', tone: 'warn' })
    } else if (topAccounts <= 0.87 && positions >= 1.15) {
      out.push({ id: 'whale-split', label: '头部仓位在多', note: '大户账户数偏空，但大户持仓量偏多。更大的仓在多头。', tone: 'warn' })
    }
  }
  const taker = input.takerBuySellRatio
  if (taker !== null && taker !== undefined && Number.isFinite(taker)) {
    out.push({
      id: 'taker',
      label: ratioWord(taker, 1.12, 0.88, '主动买', '买卖均衡', '主动卖'),
      note: '主动买/卖量比；成交口径，非持仓。',
      tone: 'neutral',
    })
  }
  const fr = input.fundingRate
  if (fr !== null && fr !== undefined && Number.isFinite(fr)) {
    const label = fundingLabelOf(fr)
    const apr = fundingAnnualizedPct(fr)
    out.push({
      id: 'funding',
      label,
      note: `${(fr * 100).toFixed(4)}%/8h，年化${apr !== null ? apr.toFixed(1) + '%' : '–'}；中性≈0.01%/8h，正费率=多付空，非看多。`,
      tone: label.includes('拥挤') ? 'warn' : 'neutral',
    })
  }
  const basis = input.basisPct
  if (basis !== null && basis !== undefined && Number.isFinite(basis)) {
    const word = basis >= 0.05 ? '升水' : basis > 0.02 ? '微升水' : basis <= -0.05 ? '贴水' : basis < -0.02 ? '微贴水' : '平水'
    out.push({
      id: 'basis',
      label: `${word} ${basis.toFixed(3)}%`,
      note: '标记相对指数；正=升水(合约贵)，非涨跌保证。',
      tone: 'neutral',
    })
  }
  return out
}

function ratioWord(ratio: number, high: number, low: number, up: string, mid: string, down: string): string {
  const word = ratio >= high ? up : ratio <= low ? down : mid
  return `${word} ${ratio.toFixed(2)}`
}

const GATE_URL = 'https://api.gateio.ws'

const GATE_SPOT_TF: Partial<Record<Timeframe, string>> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '4h': '4h', '1d': '1d', '1w': '7d',
}

async function gateSpotCandles(rawSymbol: string, timeframe: Timeframe, limit = 200): Promise<Candle[]> {
  const symbol = normalizeSymbol(rawSymbol)
  const base = symbol.replace(/(USDT|USDC)$/, '')
  const quote = symbol.endsWith('USDC') ? 'USDC' : 'USDT'
  const pair = `${base}_${quote}`
  const interval = GATE_SPOT_TF[timeframe]
  if (!interval) throw new Error(`Gate spot: unsupported timeframe ${timeframe}`)
  const url = new URL('/api/v4/spot/candlesticks', GATE_URL)
  url.searchParams.set('currency_pair', pair)
  url.searchParams.set('interval', interval)
  url.searchParams.set('limit', String(Math.min(limit, 1000)))
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  if (!res.ok) throw new Error(`Gate spot ${res.status}: ${await res.text().catch(() => '')}`)
  const rows = (await res.json()) as unknown[][]
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`Gate spot: no bars for ${pair}`)
  return rows.map(r => ({
    time: new Date(Number(r[0]) * 1000).toISOString(),
    open: Number(r[5]),
    high: Number(r[3]),
    low: Number(r[4]),
    close: Number(r[2]),
    volume: Number(r[6]),
  }))
}

const OKX_SPOT_TF: Partial<Record<Timeframe, string>> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '12h': '12H',
  '1d': '1D', '3d': '3D', '1w': '1W', '1M': '1M',
}

async function okxSpotCandles(rawSymbol: string, timeframe: Timeframe, limit = 200): Promise<Candle[]> {
  const symbol = normalizeSymbol(rawSymbol)
  const base = symbol.replace(/(USDT|USDC)$/, '')
  const quote = symbol.endsWith('USDC') ? 'USDC' : 'USDT'
  const instId = `${base}-${quote}`
  const bar = OKX_SPOT_TF[timeframe]
  if (!bar) throw new Error(`OKX spot: unsupported timeframe ${timeframe}`)
  const data = await okxGet('/api/v5/market/candles', { instId, bar, limit: String(Math.min(limit, 300)) }) as unknown[][]
  if (!Array.isArray(data) || data.length === 0) throw new Error(`OKX spot: no bars for ${instId}`)
  return data.slice().reverse().map(r => ({
    time: new Date(Number(r[0])).toISOString(),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  }))
}

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
  const past1h = stats.length > 12 ? (stats[stats.length - 13] ?? {}) : {}
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
  let oiChangePct4h: number | null = null
  let priceChangePct4h: number | null = null
  // Contracts, not USD: USD OI moves with price and would read a pure price drop as 平仓.
  const pastContracts = num(past1h['open_interest'])
  if (contracts !== null && pastContracts !== null && pastContracts > 0) {
    oiChangePct1h = Number((((contracts - pastContracts) / pastContracts) * 100).toFixed(2))
  }
  if (currentPrice !== null && pastPrice !== null && pastPrice > 0) {
    priceChangePct1h = Number((((currentPrice - pastPrice) / pastPrice) * 100).toFixed(2))
  }
  // 48×5m = 4h; series is 120 bars ≈ 10h so 24h is unavailable here.
  const past4h = stats.length > 48 ? (stats[stats.length - 49] ?? {}) : {}
  const past4c = num(past4h['open_interest'])
  const past4p = num(past4h['mark_price'])
  if (contracts !== null && past4c !== null && past4c > 0) {
    oiChangePct4h = Number((((contracts - past4c) / past4c) * 100).toFixed(2))
  }
  if (currentPrice !== null && past4p !== null && past4p > 0) {
    priceChangePct4h = Number((((currentPrice - past4p) / past4p) * 100).toFixed(2))
  }

  const posture = oiChangePct1h !== null && priceChangePct1h !== null
    ? postureOf(priceChangePct1h, oiChangePct1h, true, {
      takerRatio: num(s['lsr_taker']),
      fundingRate: num(c['funding_rate']),
    }) : null
  const quadrant = quadrantFields(priceChangePct1h, oiChangePct1h, true)

  const history: DerivativeBar[] = stats.map((item, idx) => {
    const itemContracts = num(item['open_interest'])
    const itemOi = itemContracts !== null && multiplier !== null ? itemContracts * multiplier : null
    const itemOiUsd = num(item['open_interest_usd'])
    const itemPrice = num(item['mark_price'])
    const prevItem = idx > 0 ? stats[idx - 1] : undefined
    const prevP = prevItem ? num(prevItem['mark_price']) : null
    const prevO = prevItem ? num(prevItem['open_interest_usd']) : null
    let barPosture: string | null = null
    let barQuadrant: { quadrant: string | null; quadrantNote: string | null } = { quadrant: null, quadrantNote: null }
    // Contracts, not USD: USD OI moves with price.
    const prevC = prevItem ? num(prevItem['open_interest']) : null
    if (itemPrice !== null && prevP !== null && itemContracts !== null && prevC !== null && prevC > 0 && prevP > 0) {
      const dPx = 100 * (itemPrice - prevP) / prevP
      const dOi = 100 * (itemContracts - prevC) / prevC
      barPosture = postureOf(dPx, dOi, false, {
        takerRatio: num(item['lsr_taker']),
        fundingRate: num(c['funding_rate']),
      })
      barQuadrant = quadrantFields(dPx, dOi, false)
    }
    const itemTime = num(item['time'])
    return {
      time: new Date((itemTime !== null ? itemTime : Date.now() / 1000) * 1000).toISOString(),
      openInterest: itemOi,
      openInterestValue: itemOiUsd,
      longShortRatio: num(item['lsr_account']),
      takerBuySellRatio: num(item['lsr_taker']),
      posture: barPosture,
      quadrant: barQuadrant.quadrant,
      quadrantNote: barQuadrant.quadrantNote,
    }
  })

  const gateFunding = num(c['funding_rate'])
  return {
    source: 'Gate',
    openInterest: contracts !== null && multiplier !== null ? contracts * multiplier : null,
    openInterestValue: currentOIUsd,
    oiUnit: 'base',
    fundingRate: gateFunding,
    fundingRateAnnualizedPct: fundingAnnualizedPct(gateFunding),
    fundingLabel: gateFunding !== null ? fundingLabelOf(gateFunding) : null,
    nextFundingTime: next !== null && next > 0 ? new Date(next * 1000).toISOString() : null,
    longShortRatio: num(s['lsr_account']),
    longShortRatioKind: 'global_accounts',
    takerBuySellRatio: num(s['lsr_taker']),
    time: new Date(time !== null ? time * 1000 : Date.now()).toISOString(),
    oiChangePct1h,
    oiChangePct4h,
    priceChangePct1h,
    priceChangePct4h,
    posture,
    quadrant: quadrant.quadrant,
    quadrantNote: quadrant.quadrantNote,
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
 * Recent OKX SWAP liquidations (~1h). Linear USDT notional = |sz| × ctVal × bkPx
 * (sz is contracts; ctVal is coin per contract, e.g. 0.01 BTC for BTC-USDT-SWAP).
 */
export async function okxLiquidations1h(rawSymbol: string): Promise<{
  longUsd: number
  shortUsd: number
  summary: string
}> {
  const symbol = normalizeSymbol(rawSymbol)
  const base = symbol.replace(/(USDT|USDC)$/, '')
  const quote = symbol.endsWith('USDC') ? 'USDC' : 'USDT'
  const uly = `${base}-${quote}`
  const instId = `${base}-${quote}-SWAP`
  const [data, inst] = await Promise.all([
    okxGet('/api/v5/public/liquidation-orders', {
      instType: 'SWAP',
      uly,
      state: 'filled',
    }) as Promise<Array<{ details?: Array<Record<string, unknown>> }> | null>,
    okxGet('/api/v5/public/instruments', { instType: 'SWAP', instId }).catch(() => null) as Promise<Array<Record<string, unknown>> | null>,
  ])
  const ctVal = num(inst?.[0]?.['ctVal']) ?? 1
  const cutoff = Date.now() - 60 * 60 * 1000
  let longUsd = 0
  let shortUsd = 0
  const details = (data ?? []).flatMap(row => row.details ?? [])
  for (const d of details) {
    const ts = num(d['ts'] ?? d['time']) ?? 0
    if (ts < cutoff) continue
    const px = num(d['bkPx']) ?? 0
    const sz = num(d['sz']) ?? 0
    const notional = Math.abs(sz * ctVal * px)
    // posSide long liquidated → longs flushed; short → shorts flushed
    const side = String(d['posSide'] ?? '')
    if (side === 'long') longUsd += notional
    else if (side === 'short') shortUsd += notional
  }
  return {
    longUsd: Number(longUsd.toFixed(2)),
    shortUsd: Number(shortUsd.toFixed(2)),
    summary: `近1h爆仓 多${formatUsdtCn(longUsd)} / 空${formatUsdtCn(shortUsd)}`,
  }
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

  // Each leg degrades alone; no OI → getDerivatives falls through to Gate.
  // 5m hist covers ~8h (1h/4h); 15m hist covers ~25h for Δ24h.
  const [fundingData, oiData, oihData, oih15Data, topData, takerData, markData, indexData] = await Promise.all([
    okxGet('/api/v5/public/funding-rate', { instId }).catch(() => null),
    okxGet('/api/v5/public/open-interest', { instType: 'SWAP', instId }).catch(() => null),
    okxGet('/api/v5/rubik/stat/contracts/open-interest-history', { instId, period: '5m' }).catch(() => null),
    okxGet('/api/v5/rubik/stat/contracts/open-interest-history', { instId, period: '15m' }).catch(() => null),
    okxGet('/api/v5/rubik/stat/contracts/long-short-position-ratio-contract-top-trader', { instId, period: '5m' }).catch(() => null),
    okxGet('/api/v5/rubik/stat/taker-volume-contract', { instId, period: '5m', unit: '1' }).catch(() => null),
    okxGet('/api/v5/public/mark-price', { instType: 'SWAP', instId }).catch(() => null),
    okxGet('/api/v5/market/index-tickers', { instId: `${base}-${quote}` }).catch(() => null),
  ])
  if (!Array.isArray(oiData) || oiData.length === 0) throw new Error(`OKX open interest unavailable for ${instId}`)

  const f = (fundingData as Array<Record<string, unknown>> | null)?.[0] ?? {}
  const o = (oiData as Array<Record<string, unknown>>)[0]!
  // Newest first: [ts, oi(contracts), oiCcy(base units), oiUsd]
  const oih = (oihData as Array<[string, string, string, string]> | null) ?? []
  const oih15 = (oih15Data as Array<[string, string, string, string]> | null) ?? []
  const top = (topData as Array<[string, string]> | null) ?? []
  // Newest first: [ts, sellVol, buyVol]
  const taker = (takerData as Array<[string, string, string]> | null) ?? []
  const markRow = (markData as Array<Record<string, unknown>> | null)?.[0] ?? {}
  const indexRow = (indexData as Array<Record<string, unknown>> | null)?.[0] ?? {}

  const oi = num(o['oiCcy']) ?? num(o['oi'])
  const oiUsd = num(o['oiUsd'])
  const fundingRate = num(f['fundingRate'])
  const nextFundingTime = f['nextFundingTime'] ? new Date(Number(f['nextFundingTime'])).toISOString() : null
  const time = o['ts'] ? new Date(Number(o['ts'])).toISOString() : new Date().toISOString()
  const nowMs = num(o['ts']) ?? Date.now()

  // Base-unit OI + implied mark (oiUsd/oiCcy) for the same price×OI quadrant as Binance/Gate.
  const pt = (row: [string, string, string, string] | undefined): { oi: number | null; px: number | null; ts: number | null } => {
    const ccy = num(row?.[2])
    const usd = num(row?.[3])
    return {
      oi: ccy,
      px: ccy !== null && usd !== null && ccy > 0 ? usd / ccy : null,
      ts: num(row?.[0]),
    }
  }
  const sampleOkx = (
    rows: Array<[string, string, string, string]>,
    lookbackMs: number,
    slackMs: number,
  ): { oi: number | null; px: number | null } => {
    const target = nowMs - lookbackMs
    let best: [string, string, string, string] | undefined
    let bestTs = -Infinity
    for (const row of rows) {
      const ts = num(row[0])
      const ccy = num(row[2])
      if (ts === null || ts > target || ccy === null || !(ccy > 0)) continue
      if (ts > bestTs) { best = row; bestTs = ts }
    }
    if (!best || target - bestTs > slackMs) return { oi: null, px: null }
    return pt(best)
  }
  // Rubik sometimes pads the newest 5m bucket with zeros while it is still open — skip those.
  const usable = (row: [string, string, string, string] | undefined): boolean => {
    const ccy = num(row?.[2])
    return ccy !== null && ccy > 0
  }
  const firstUsable = (rows: Array<[string, string, string, string]>): number => {
    const i = rows.findIndex(usable)
    return i < 0 ? 0 : i
  }
  const head = firstUsable(oih)
  const now = pt(oih[head])
  // Prefer live open-interest endpoint; hist head can be a zero pad.
  const liveOi = (oi !== null && oi > 0) ? oi : (now.oi !== null && now.oi > 0 ? now.oi : null)
  const livePx = (oi !== null && oiUsd !== null && oi > 0)
    ? oiUsd / oi
    : (now.px ?? null)
  // 5m rubik hist is newest-first: from first usable bar, +12 ≈ 1h, +48 ≈ 4h.
  const byIndex = (rows: Array<[string, string, string, string]>, barsBack: number) => {
    const start = firstUsable(rows)
    const idx = start + barsBack
    return rows.length > idx && usable(rows[idx])
      ? pt(rows[idx])
      : { oi: null as number | null, px: null as number | null, ts: null as number | null }
  }
  const i1 = byIndex(oih, 12)
  const i4 = byIndex(oih, 48)
  const i24 = byIndex(oih15, 96)
  const a1 = i1.oi !== null ? i1 : sampleOkx(oih, 60 * 60 * 1000, 15 * 60 * 1000)
  const a4 = i4.oi !== null ? i4 : sampleOkx(oih, 4 * 60 * 60 * 1000, 20 * 60 * 1000)
  // 5m only reaches ~8h; 15m×96 ≈ 24h.
  const a24 = i24.oi !== null
    ? i24
    : sampleOkx(oih15.length > 0 ? oih15 : oih, 24 * 60 * 60 * 1000, 45 * 60 * 1000)
  const oiChangePct1h = pctChange(liveOi, a1.oi)
  const oiChangePct4h = pctChange(liveOi, a4.oi)
  const oiChangePct24h = pctChange(liveOi, a24.oi)
  const priceChangePct1h = pctChange(livePx, a1.px)
  const priceChangePct4h = pctChange(livePx, a4.px)
  const priceChangePct24h = pctChange(livePx, a24.px)

  const topPositionRatio = num(top[0]?.[1])
  const sell = num(taker[0]?.[1])
  const buy = num(taker[0]?.[2])
  const takerBuySellRatio = buy !== null && sell !== null && sell > 0
    ? Number((buy / sell).toFixed(4))
    : buy !== null && sell === 0 && buy > 0 ? 99 : null
  // CVD over ~1h from 5m taker bars (newest first).
  let cvd1h: number | null = null
  {
    const cutoff = nowMs - 60 * 60 * 1000
    let sum = 0
    let n = 0
    for (const row of taker) {
      const ts = num(row[0])
      if (ts === null || ts < cutoff) continue
      const s = num(row[1])
      const b = num(row[2])
      if (b === null || s === null) continue
      sum += b - s
      n += 1
    }
    cvd1h = n === 0 ? null : Number(sum.toFixed(4))
  }
  const cvdNote = cvdNoteOf(cvd1h, priceChangePct1h)
  const markPx = num(markRow['markPx'])
  const idxPx = num(indexRow['idxPx']) ?? num(markRow['idxPx'])
  const basis = basisPct(markPx, idxPx)
  // OKX rubik top-trader is position-size ratio; no global account ratio on this endpoint.
  const crowdVsWhale = null
  const readings = positionReadings({
    topPositionRatio,
    takerBuySellRatio,
    fundingRate,
    basisPct: basis,
  })

  const posture = oiChangePct1h !== null && priceChangePct1h !== null
    ? postureOf(priceChangePct1h, oiChangePct1h, true, { takerRatio: takerBuySellRatio, fundingRate }) : null
  const quadrant = quadrantFields(priceChangePct1h, oiChangePct1h, true)

  const history: DerivativeBar[] = [...oih].reverse().map((row, i, asc) => {
    const cur = pt(row)
    const prev = i > 0 ? pt(asc[i - 1]) : null
    const dOi = prev ? pctChange(cur.oi, prev.oi) : null
    const dPx = prev ? pctChange(cur.px, prev.px) : null
    return {
      time: new Date(num(row[0]) ?? Date.now()).toISOString(),
      openInterest: cur.oi,
      openInterestValue: num(row[3]),
      longShortRatio: null,
      takerBuySellRatio,
      topPositionRatio,
      posture: dOi !== null && dPx !== null ? postureOf(dPx, dOi, false, {
        takerRatio: takerBuySellRatio,
        fundingRate,
      }) : null,
      ...quadrantFields(dPx, dOi, false),
    }
  })

  let liquidationLongUsd1h: number | null = null
  let liquidationShortUsd1h: number | null = null
  let liquidationSummary: string | null = null
  try {
    const liq = await okxLiquidations1h(symbol)
    liquidationLongUsd1h = liq.longUsd
    liquidationShortUsd1h = liq.shortUsd
    liquidationSummary = liq.summary
  } catch {
    // liquidations are best-effort
  }

  return {
    source: 'OKX',
    openInterest: oi,
    openInterestValue: oiUsd,
    oiUnit: 'base',
    fundingRate,
    fundingRateAnnualizedPct: fundingAnnualizedPct(fundingRate),
    fundingLabel: fundingRate !== null ? fundingLabelOf(fundingRate) : null,
    nextFundingTime,
    longShortRatio: null,
    longShortRatioKind: 'top_positions',
    topPositionRatio,
    takerBuySellRatio,
    cvd1h,
    cvdNote,
    basisPct: basis,
    crowdVsWhale,
    readings,
    time,
    oiChangePct1h,
    oiChangePct4h,
    oiChangePct24h,
    priceChangePct1h,
    priceChangePct4h,
    priceChangePct24h,
    posture,
    quadrant: quadrant.quadrant,
    quadrantNote: quadrant.quadrantNote,
    history,
    liquidationLongUsd1h,
    liquidationShortUsd1h,
    liquidationSummary,
    liquidationSource: 'OKX',
  }
}



/** First-class OKX spot + SWAP provider (id: `okx`). Shares symbol catalogue with Binance tickers. */
export class OkxMarketProvider implements MarketDataProvider {
  readonly id: string
  readonly description: string
  constructor(
    id: string,
    private readonly symbols: string[],
  ) {
    this.id = id
    this.description = `OKX public spot klines + SWAP derivatives (${symbols.length} symbols)`
  }

  matchesSymbol(symbol: string): boolean {
    return isBinanceSymbol(symbol)
  }

  async listSymbols(): Promise<InstrumentInfo[]> {
    return this.symbols.map(symbol => ({ symbol, timeframes: [...ALL_TIMEFRAMES] }))
  }

  async getOhlcv(query: OhlcvQuery): Promise<Candle[]> {
    return okxSpotCandles(query.symbol, query.timeframe, query.limit ?? 200)
  }

  async getDerivatives(rawSymbol: string): Promise<Derivatives> {
    return okxDerivatives(rawSymbol)
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.marketData.register(
    new BinanceProvider(config.id ?? 'binance', config.symbols, config.baseURL, config.futuresURL ?? 'https://fapi.binance.com'),
  ))
  if (config.registerOkx !== false) {
    ctx.effect(() => ctx.marketData.register(
      new OkxMarketProvider('okx', config.okxSymbols?.length ? config.okxSymbols : config.symbols),
    ))
  }
}
