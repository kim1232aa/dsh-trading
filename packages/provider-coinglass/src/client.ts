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

function normalizeMarketType(inst: { contractType?: string | null; type?: string | number }): 'spot' | 'perp' {
  if (Number(inst.type) === 10 || String(inst.contractType ?? '').toUpperCase() === 'SPOT') {
    return 'spot'
  }
  return 'perp'
}

/** Flatten venue groups into wall rows. side: 1=sell, 2=buy. */
export function flattenWalls(groups: unknown): LargeOrderWall[] {
  if (!Array.isArray(groups)) return []
  const rows: LargeOrderWall[] = []
  for (const g of groups as RawGroup[]) {
    const inst = g.instrument ?? {}
    const market = normalizeMarketType(inst)
    const instrumentId = typeof inst.instrumentId === 'string' && inst.instrumentId ? inst.instrumentId : undefined
    for (const o of g.list ?? []) {
      const side = o.side === 1 ? 'sell' : o.side === 2 ? 'buy' : null
      if (side === null) continue
      const price = Number(o.price)
      if (!Number.isFinite(price) || price <= 0) continue
      rows.push({
        id: o.id ?? `${inst.exName}-${price}-${o.startTime}`,
        exchange: String(inst.exName ?? ''),
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
        startTime: Number(o.startTime) || 0,
        currentTime: Number(o.currentTime) || 0,
      })
    }
  }
  return rows
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

  constructor(config: CoinglassClientConfig = {}) {
    this.baseURL = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.defaultExchange = config.defaultExchange ?? 'Binance'
    this.defaultMarket = config.defaultMarket ?? 'perp'
    this.timeoutMs = config.timeoutMs ?? 30_000
    this.userAgent = config.userAgent
      ?? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
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
    const hours = opts.hours ?? 72
    const top = opts.top ?? 40
    const end = Math.floor(Date.now() / 1000)
    const start = end - Math.max(1, Math.floor(hours * 3600))
    const raw = await this.largeTakerOrder(mapped.cgSymbol, start, end, opts.signal)
    let walls = flattenWalls(raw)
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
    if (prices.length > 0) {
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
      } catch {
        // Statistics are optional; walls alone are enough for the tool/overlay.
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
      updatedAt: Date.now(),
    }
  }
}
