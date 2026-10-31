/**
 * CoinGlass capi HTTP client (largeTakerOrder / largeOrder / revoke / statistics).
 * @module
 */
import { decryptCapiBody } from './decrypt.js'
import { renderLargeOrders } from './format.js'
import { toCgSymbol } from './symbol.js'
import type {
  FetchLargeOrdersOptions,
  LargeOrderStatistics,
  LargeOrderWall,
  LargeOrdersSnapshot,
} from './types.js'

export { renderLargeOrders }

export const DEFAULT_BASE_URL = 'https://capi.coinglass.com'

export interface CoinglassClientConfig {
  baseURL?: string
  /** Default exchange when mapping BTCUSDT → Binance_BTCUSDT. */
  defaultExchange?: string
  /** Default market: perp | spot. */
  defaultMarket?: 'perp' | 'spot'
  /** Fetch timeout ms. */
  timeoutMs?: number
  /** User-Agent. */
  userAgent?: string
  /** Fresh window of the primary (Binance-routed) wall pull, ms. Default 15 000. */
  primaryTtlMs?: number
  /** Fresh window of each secondary venue pull, ms. Default 60 000. */
  secondaryTtlMs?: number
  /** Clock, for tests. */
  now?: () => number
}

/** A raw largeTakerOrder answer and when it was pulled. */
interface RawPull {
  at: number
  groups: unknown
}

/** Oldest raw pull still served when CoinGlass refuses a fresh one. */
const STALE_MAX_MS = 10 * 60_000
/** First cooldown after HTTP 429; doubles per repeated 429 up to the max. */
const COOLDOWN_BASE_MS = 15_000
const COOLDOWN_MAX_MS = 120_000

/** CoinGlass answered 429 Too Many Requests. */
export function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && /\bHTTP 429\b/.test(err.message)
}

/** Settle with `p`, or reject as soon as `signal` aborts — without cancelling `p` for other waiters. */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

type RawGroup = {
  instrument?: {
    exName?: string
    baseAsset?: string
    contractType?: string | null
    type?: string | number
    instrumentId?: string
  }
  list?: RawOrder[]
}

type RawOrder = {
  id?: string | number
  side?: number
  price?: number
  startUsd?: number
  currentUsd?: number
  startAmount?: number
  currentAmount?: number
  volUsd?: number
  state?: number
  startTime?: number
  currentTime?: number
}

type RawStats = {
  instrument?: { exName?: string; baseAsset?: string; contractType?: string | null; type?: string | number; instrumentId?: string }
  bidsTotalUsd?: number
  asksTotalUsd?: number
  buyVolUsd?: number
  sellVolUsd?: number
}

const QUOTE_SUFFIXES = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'USD'] as const

function extractBaseAsset(pair: string): string {
  for (const q of QUOTE_SUFFIXES) {
    if (pair.length > q.length && pair.endsWith(q)) {
      return pair.slice(0, -q.length)
    }
  }
  return pair
}

type SecondarySymbolSpec = {
  exchange: string
  market: 'perp' | 'spot'
  build: (base: string) => string
}

const SECONDARY_EXCHANGE_SPECS: readonly SecondarySymbolSpec[] = [
  { exchange: 'Bybit', market: 'perp', build: base => `Bybit_${base}USDT` },
  { exchange: 'Bybit', market: 'spot', build: base => `Bybit_SPOT_${base}USDT` },
  { exchange: 'Hyperliquid', market: 'perp', build: base => `Hyperliquid_${base}-USD` },
  { exchange: 'Bitget', market: 'perp', build: base => `Bitget_${base}USDT_UMCBL` },
  { exchange: 'Bitget', market: 'spot', build: base => `Bitget_SPOT_${base}USDT` },
  { exchange: 'Gate', market: 'perp', build: base => `Gate_${base}_USDT` },
  { exchange: 'Gate', market: 'spot', build: base => `Gate_SPOT_${base}_USDT` },
  { exchange: 'Aster', market: 'perp', build: base => `Aster_${base}USDT` },
  { exchange: 'Bitfinex', market: 'perp', build: base => `Bitfinex_t${base}F0:USTF0` },
  { exchange: 'Bitfinex', market: 'spot', build: base => `Bitfinex_SPOT_${base}USD` },
  { exchange: 'Bitstamp', market: 'spot', build: base => `Bitstamp_SPOT_${base}USD` },
  { exchange: 'Kraken', market: 'spot', build: base => `Kraken_SPOT_${base === 'BTC' ? 'XBT' : base}/USD` },
]

/**
 * Build CoinGlass capi symbol keys across exchanges.
 * - Custom cgSymbol with an underscore (e.g. 'Bybit_BTCUSDT'), explicit exchange prefix (e.g. 'okx:BTCUSDT'),
 *   non-default opts.exchange, or specific opts.venue: only query the relevant symbol(s).
 * - Standard pair (e.g. 'BTCUSDT' or 'ETHUSDT'): return primary ('Binance_BTCUSDT') plus secondary
 *   exchange symbols (filtered by marketType if 'spot' or 'perp').
 */
export function buildMultiExchangeCgSymbols(
  rawSymbol: string,
  opts?: {
    exchange?: string
    market?: 'perp' | 'spot'
    venue?: string
    marketType?: 'all' | 'spot' | 'perp'
  },
): string[] {
  const trimmed = rawSymbol.trim()

  if (trimmed.includes('_')) {
    if (/^(Binance|OKX|Bybit|Bitget|Coinbase|Huobi|Kraken)_(SPOT_)?([A-Z0-9]+)$/i.test(trimmed.replace(/\s+/g, ''))) {
      return [toCgSymbol(trimmed).cgSymbol]
    }
    return [trimmed]
  }

  const exchangeOpt = opts?.exchange?.trim()
  const hasNonDefaultExchange = Boolean(exchangeOpt && exchangeOpt.toLowerCase() !== 'binance')
  const mapped = toCgSymbol(trimmed, {
    exchange: exchangeOpt ?? 'Binance',
    market: opts?.market ?? 'perp',
  })

  if (trimmed.includes(':') || hasNonDefaultExchange) {
    return [mapped.cgSymbol]
  }

  const base = extractBaseAsset(mapped.pair)
  const marketFilter = opts?.marketType === 'spot' || opts?.marketType === 'perp' ? opts.marketType : undefined

  const venueOpt = opts?.venue?.trim()
  if (venueOpt) {
    const vLower = venueOpt.toLowerCase()
    if (vLower === 'binance' || vLower === 'okx' || vLower === 'okex' || vLower === 'coinbase') {
      return [mapped.cgSymbol]
    }
    const venueSpecs = SECONDARY_EXCHANGE_SPECS.filter(s => s.exchange.toLowerCase() === vLower)
    if (venueSpecs.length > 0) {
      const filtered = marketFilter ? venueSpecs.filter(s => s.market === marketFilter) : venueSpecs
      const chosen = filtered.length > 0 ? filtered : venueSpecs
      return chosen.map(s => s.build(base))
    }
    return [mapped.cgSymbol]
  }

  const secondarySpecs = marketFilter
    ? SECONDARY_EXCHANGE_SPECS.filter(s => s.market === marketFilter)
    : SECONDARY_EXCHANGE_SPECS
  return [mapped.cgSymbol, ...secondarySpecs.map(s => s.build(base))]
}

function normalizeMarketType(inst: { contractType?: string | null; type?: string | number }): 'spot' | 'perp' {
  if (Number(inst.type) === 10 || String(inst.contractType ?? '').toUpperCase() === 'SPOT') {
    return 'spot'
  }
  return 'perp'
}

/** Deduplicate flattened walls by wall.id and fallback key. */
export function deduplicateWalls(walls: LargeOrderWall[]): LargeOrderWall[] {
  const seenIds = new Set<string>()
  const seenFallbacks = new Set<string>()
  const out: LargeOrderWall[] = []
  for (const w of walls) {
    const idKey = w.id !== undefined && w.id !== null && String(w.id) !== '' ? String(w.id) : undefined
    const venue = (w as { venue?: string }).venue ?? w.exchange
    const fallbackKey = `${venue}:${w.market}:${w.side}:${w.price}:${w.startTime}`
    if ((idKey !== undefined && seenIds.has(idKey)) || seenFallbacks.has(fallbackKey)) {
      continue
    }
    if (idKey !== undefined) seenIds.add(idKey)
    seenFallbacks.add(fallbackKey)
    out.push(w)
  }
  return out
}

/** Flatten venue groups into wall rows. side: 1=sell, 2=buy. */
export function flattenWalls(groups: unknown): LargeOrderWall[] {
  if (!Array.isArray(groups)) return []
  const rows: LargeOrderWall[] = []
  for (const g of groups as RawGroup[]) {
    const inst = g.instrument ?? {}
    const market = normalizeMarketType(inst)
    const instrumentId = typeof inst.instrumentId === 'string' && inst.instrumentId ? inst.instrumentId : undefined
    const exchange = String(inst.exName ?? '')
    for (const o of g.list ?? []) {
      const side = o.side === 1 ? 'sell' : o.side === 2 ? 'buy' : null
      if (side === null) continue
      const price = Number(o.price)
      if (!Number.isFinite(price) || price <= 0) continue
      const startTime = Number(o.startTime) || 0
      const fallbackKey = `${exchange}:${market}:${side}:${price}:${startTime}`
      rows.push({
        id: o.id ?? fallbackKey,
        exchange,
        ...(inst.baseAsset !== undefined ? { baseAsset: String(inst.baseAsset) } : {}),
        market,
        ...(instrumentId !== undefined ? { instrumentId } : {}),
        side,
        price,
        startUsd: Number(o.startUsd) || 0,
        currentUsd: Number(o.currentUsd) || 0,
        startAmount: Number(o.startAmount) || 0,
        currentAmount: Number(o.currentAmount) || 0,
        volUsd: Number(o.volUsd) || 0,
        state: Number(o.state) || 0,
        startTime,
        currentTime: Number(o.currentTime) || 0,
      })
    }
  }
  return deduplicateWalls(rows)
}

function flattenStats(raw: unknown): LargeOrderStatistics[] {
  if (!Array.isArray(raw)) return []
  return (raw as RawStats[]).map(s => {
    const inst = s.instrument ?? {}
    const row: LargeOrderStatistics = {
      exchange: String(inst.exName ?? ''),
      bidsTotalUsd: Number(s.bidsTotalUsd) || 0,
      asksTotalUsd: Number(s.asksTotalUsd) || 0,
      market: normalizeMarketType(inst),
    }
    if (inst.baseAsset !== undefined) row.baseAsset = String(inst.baseAsset)
    if (s.buyVolUsd !== undefined) row.buyVolUsd = Number(s.buyVolUsd) || 0
    if (s.sellVolUsd !== undefined) row.sellVolUsd = Number(s.sellVolUsd) || 0
    return row
  })
}

export class CoinglassCapi {
  readonly baseURL: string
  readonly defaultExchange: string
  readonly defaultMarket: 'perp' | 'spot'
  readonly timeoutMs: number
  readonly userAgent: string
  readonly primaryTtlMs: number
  readonly secondaryTtlMs: number
  readonly now: () => number
  /**
   * Raw wall pulls by `symbol|hours`. CoinGlass rate-limits by IP: one poll is a
   * 14-venue fan-out, so every caller (chart strip, overlay, large_orders tool,
   * other tabs) must share pulls instead of each hitting capi.
   */
  private readonly rawPulls = new Map<string, RawPull>()
  private readonly rawInflight = new Map<string, Promise<RawPull>>()
  private cooldownUntil = 0
  private cooldownMs = 0

  constructor(config: CoinglassClientConfig = {}) {
    this.baseURL = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.defaultExchange = config.defaultExchange ?? 'Binance'
    this.defaultMarket = config.defaultMarket ?? 'perp'
    this.timeoutMs = config.timeoutMs ?? 30_000
    this.userAgent = config.userAgent
      ?? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    this.primaryTtlMs = config.primaryTtlMs ?? 15_000
    this.secondaryTtlMs = config.secondaryTtlMs ?? 60_000
    this.now = config.now ?? Date.now
  }

  /** Start (or double) the HTTP 429 cooldown. A fan-out collects several 429s at once; escalate once per round. */
  private noteRateLimit(): void {
    const now = this.now()
    if (this.cooldownUntil > now) return
    this.cooldownMs = Math.min(COOLDOWN_MAX_MS, this.cooldownMs > 0 ? this.cooldownMs * 2 : COOLDOWN_BASE_MS)
    this.cooldownUntil = now + this.cooldownMs
  }

  /** ms left in the HTTP 429 cooldown; 0 when capi may be called. */
  rateLimitRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - this.now())
  }

  /**
   * One venue's raw walls: cached within `ttlMs`, one request in flight per key,
   * no request during a 429 cooldown. A refused or failed pull falls back to the
   * last good one (up to STALE_MAX_MS old); callers read its age from `at`.
   */
  private pullRaw(cgSymbol: string, start: number, end: number, hours: number, ttlMs: number, signal?: AbortSignal): Promise<RawPull> {
    const key = `${cgSymbol}|${hours}`
    const t = this.now()
    const cached = this.rawPulls.get(key)
    if (cached && t - cached.at < ttlMs) return Promise.resolve(cached)
    const usable = (): RawPull | undefined => {
      const last = this.rawPulls.get(key)
      return last && this.now() - last.at <= STALE_MAX_MS ? last : undefined
    }
    if (this.cooldownUntil > t) {
      const last = usable()
      if (last) return Promise.resolve(last)
      return Promise.reject(new Error(
        `coinglass HTTP 429 cooldown: retry in ${Math.ceil((this.cooldownUntil - t) / 1000)}s`,
      ))
    }
    let pending = this.rawInflight.get(key)
    if (!pending) {
      // Not tied to the caller's signal: other waiters share this request.
      pending = this.largeTakerOrder(cgSymbol, start, end).then(
        (groups): RawPull => {
          this.rawInflight.delete(key)
          const pull = { at: this.now(), groups }
          this.rawPulls.set(key, pull)
          this.cooldownMs = 0
          return pull
        },
        (err: unknown): RawPull => {
          this.rawInflight.delete(key)
          if (isRateLimitError(err)) this.noteRateLimit()
          const last = usable()
          if (last) return last
          throw err
        },
      )
      this.rawInflight.set(key, pending)
    }
    return raceAbort(pending, signal)
  }

  /** GET one encrypted endpoint and decrypt. */
  async fetchPath(path: string, params: Record<string, string | number>, signal?: AbortSignal): Promise<unknown> {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v))
    const url = `${this.baseURL}${path}?${qs.toString()}`
    const cacheTs = String(Date.now())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const resp = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'cache-ts-v2': cacheTs,
          encryption: 'true',
          language: 'zh',
          Origin: 'https://www.coinglass.com',
          Referer: 'https://www.coinglass.com/zh/large-orderbook-statistics',
          'User-Agent': this.userAgent,
        },
      })
      const bodyText = await resp.text()
      if (!resp.ok) throw new Error(`coinglass HTTP ${resp.status}: ${bodyText.slice(0, 200)}`)
      const user = resp.headers.get('user')
      const v = resp.headers.get('v')
      let parsed: { data?: unknown }
      try {
        parsed = JSON.parse(bodyText) as { data?: unknown }
      } catch {
        throw new Error(`coinglass non-JSON body: ${bodyText.slice(0, 200)}`)
      }
      if (user && v && typeof parsed.data === 'string' && parsed.data.length > 0) {
        return decryptCapiBody(bodyText, {
          url,
          cacheTsV2: cacheTs,
          timeHeader: resp.headers.get('time') ?? '',
          user,
          v,
        })
      }
      return parsed.data ?? parsed
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async largeTakerOrder(cgSymbol: string, startSec: number, endSec: number, signal?: AbortSignal): Promise<unknown> {
    return this.fetchPath('/api/largeTakerOrder', { symbol: cgSymbol, startTime: startSec, endTime: endSec }, signal)
  }

  async largeOrder(cgSymbol: string, startSec: number, endSec: number, signal?: AbortSignal): Promise<unknown> {
    return this.fetchPath('/api/largeOrder', { symbol: cgSymbol, startTime: startSec, endTime: endSec }, signal)
  }

  async largeTakerOrderRevoke(cgSymbol: string, startSec: number, endSec: number, signal?: AbortSignal): Promise<unknown> {
    return this.fetchPath('/api/largeTakerOrder/revoke', { symbol: cgSymbol, startTime: startSec, endTime: endSec }, signal)
  }

  async largeTakerOrderStatistics(
    cgSymbol: string,
    startSec: number,
    endSec: number,
    minPrice: number,
    maxPrice: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.fetchPath('/api/largeTakerOrder/statistics', {
      symbol: cgSymbol,
      startTime: startSec,
      endTime: endSec,
      minPrice,
      maxPrice,
    }, signal)
  }

  async largeOrderStatistics(
    cgSymbol: string,
    startSec: number,
    endSec: number,
    minPrice: number,
    maxPrice: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.fetchPath('/api/largeOrder/statistics', {
      symbol: cgSymbol,
      startTime: startSec,
      endTime: endSec,
      minPrice,
      maxPrice,
    }, signal)
  }

  /**
   * High-level: map a dsh symbol, pull resting walls + statistics, return top N.
   */
  async getLargeOrders(symbol: string, opts: FetchLargeOrdersOptions = {}): Promise<LargeOrdersSnapshot> {
    const mapped = toCgSymbol(symbol, {
      exchange: this.defaultExchange,
      market: this.defaultMarket,
    })
    const cgSymbols = buildMultiExchangeCgSymbols(symbol, {
      exchange: this.defaultExchange,
      market: this.defaultMarket,
      ...(opts.venue !== undefined ? { venue: opts.venue } : {}),
      ...(opts.marketType !== undefined ? { marketType: opts.marketType } : {}),
    })
    const hours = opts.hours ?? 72
    const top = opts.top ?? 40
    const end = Math.floor(Date.now() / 1000)
    const start = end - Math.max(1, Math.floor(hours * 3600))
    // The primary (Binance-routed) answer already carries Binance + OKX +
    // Coinbase books and refreshes fast; secondary venues refresh slower so a
    // 20 s chart poll costs ~1 request, not 14.
    const settled = await Promise.allSettled(
      cgSymbols.map((sym, i) => this.pullRaw(
        sym, start, end, hours, i === 0 ? this.primaryTtlMs : this.secondaryTtlMs, opts.signal,
      )),
    )
    const primaryResult = settled[0]
    if (!primaryResult || primaryResult.status === 'rejected') {
      throw primaryResult ? primaryResult.reason : new Error(`coinglass fetch failed for ${mapped.cgSymbol}`)
    }
    const primary = primaryResult.value
    const stale = this.now() - primary.at >= this.primaryTtlMs
    let failedSources = 0
    const mergedGroups: unknown[] = []
    for (const res of settled) {
      if (res.status === 'rejected') {
        failedSources += 1
        continue
      }
      if (Array.isArray(res.value.groups)) mergedGroups.push(...res.value.groups)
    }
    let walls = deduplicateWalls(flattenWalls(mergedGroups))
    if (opts.venue) {
      const v = opts.venue.toLowerCase()
      walls = walls.filter(w => w.exchange.toLowerCase() === v)
    }
    if (opts.marketType === 'spot' || opts.marketType === 'perp') {
      walls = walls.filter(w => w.market === opts.marketType)
    }
    const status = opts.status ?? 'active'
    if (status === 'active') {
      walls = walls.filter(w => w.state === 1)
    } else if (status === 'revoked') {
      walls = walls.filter(w => w.state === 2)
    }

    if (opts.minUsd !== undefined && opts.minUsd > 0) {
      walls = walls.filter(w => w.currentUsd >= opts.minUsd!)
    }

    const hasCurrentPrice = typeof opts.currentPrice === 'number' && Number.isFinite(opts.currentPrice) && opts.currentPrice > 0
    if (hasCurrentPrice) {
      const maxDist = opts.maxDistancePct ?? 0.35
      walls = walls.filter(w => Math.abs(w.price - opts.currentPrice!) / opts.currentPrice! <= maxDist)
    }

    const orderCount = walls.length

    let selectedWalls: LargeOrderWall[]
    if (opts.balanced !== false) {
      const half = Math.ceil(top / 2)
      if (hasCurrentPrice) {
        const buys = walls
          .filter(w => w.side === 'buy')
          .sort((a, b) => b.price - a.price || b.currentUsd - a.currentUsd)
        const sells = walls
          .filter(w => w.side === 'sell')
          .sort((a, b) => a.price - b.price || b.currentUsd - a.currentUsd)
        const pickBuys = buys.slice(0, half)
        const pickSells = sells.slice(0, half)
        selectedWalls = [...pickBuys, ...pickSells]
      } else {
        const buys = walls
          .filter(w => w.side === 'buy')
          .sort((a, b) => b.currentUsd - a.currentUsd)
        const sells = walls
          .filter(w => w.side === 'sell')
          .sort((a, b) => b.currentUsd - a.currentUsd)
        const pickBuys = buys
          .slice(0, half)
          .sort((a, b) => b.price - a.price || b.currentUsd - a.currentUsd)
        const pickSells = sells
          .slice(0, half)
          .sort((a, b) => a.price - b.price || b.currentUsd - a.currentUsd)
        selectedWalls = [...pickBuys, ...pickSells]
      }
    } else {
      walls.sort((a, b) => b.currentUsd - a.currentUsd)
      selectedWalls = walls.slice(0, top)
    }

    let statistics: LargeOrderStatistics[] = []
    const prices = selectedWalls.map(w => w.price).filter(p => p > 0)
    if (prices.length > 0 && opts.statistics !== false && this.cooldownUntil <= this.now()) {
      const minP = opts.minPrice ?? Math.min(...prices) * 0.98
      const maxP = opts.maxPrice ?? Math.max(...prices) * 1.02
      try {
        const statsRaw = await this.largeTakerOrderStatistics(
          mapped.cgSymbol, start, end, minP, maxP, opts.signal,
        )
        statistics = flattenStats(statsRaw)
        if (opts.venue) {
          const v = opts.venue.toLowerCase()
          statistics = statistics.filter(s => s.exchange.toLowerCase() === v)
        }
        if (opts.marketType === 'spot' || opts.marketType === 'perp') {
          statistics = statistics.filter(s => s.market === opts.marketType)
        }
      } catch (err) {
        // Statistics are optional; walls alone are enough for the tool/overlay.
        if (isRateLimitError(err)) this.noteRateLimit()
      }
    }

    return {
      cgSymbol: mapped.cgSymbol,
      pair: mapped.pair,
      startTime: start,
      endTime: end,
      orderCount,
      walls: selectedWalls,
      statistics,
      updatedAt: primary.at,
      ...(stale ? { stale: true } : {}),
      ...(failedSources > 0 ? { failedSources } : {}),
    }
  }
}
