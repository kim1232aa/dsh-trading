/**
 * CoinGlass capi large-order provider. Not an OHLCV MarketDataProvider —
 * exposes `ctx.coinglass` for tool-market / client-chart.
 * Private frontend API; may break without notice.
 * @module @dsh-trading/provider-coinglass
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CoinglassCapi } from './client.js'
import type { CoinglassClientConfig } from './client.js'
import type { FetchLargeOrdersOptions, LargeOrdersSnapshot } from './types.js'

export { CoinglassCapi, flattenWalls, DEFAULT_BASE_URL } from './client.js'
export type { CoinglassClientConfig } from './client.js'
export { decryptCapiBody, deriveKey0 } from './decrypt.js'
export type { DecryptContext } from './decrypt.js'
export { toCgSymbol, normalizePair } from './symbol.js'
export type { CgMarket, CgSymbolParts } from './symbol.js'
export { formatUsdCn, formatAge, formatWallLine, renderLargeOrders } from './format.js'
export type {
  LargeOrderWall,
  LargeOrderStatistics,
  LargeOrdersSnapshot,
  FetchLargeOrdersOptions,
} from './types.js'

export const name = 'provider-coinglass'
export const inject = []

export interface Config {
  /** Master switch. When false, getLargeOrders throws a clear disabled error. */
  enabled: boolean
  baseURL: string
  defaultExchange: string
  defaultMarket: 'perp' | 'spot'
  timeoutMs: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  baseURL: z.string().default('https://capi.coinglass.com'),
  defaultExchange: z.string().default('Binance'),
  defaultMarket: z.union(['perp', 'spot'] as const).default('perp'),
  timeoutMs: z.number().default(30_000),
}) as unknown as z<Config>

declare module '@deepseek-ai/cordis' {
  interface Context {
    coinglass: CoinglassService
  }
}

/** Cordis service wrapping {@link CoinglassCapi}. */
export class CoinglassService extends Service {
  readonly client: CoinglassCapi
  readonly enabled: boolean

  constructor(ctx: Context, config: Config) {
    super(ctx, 'coinglass')
    this.enabled = config.enabled
    const clientConfig: CoinglassClientConfig = {
      baseURL: config.baseURL,
      defaultExchange: config.defaultExchange,
      defaultMarket: config.defaultMarket,
      timeoutMs: config.timeoutMs,
    }
    this.client = new CoinglassCapi(clientConfig)
  }

  async getLargeOrders(symbol: string, opts: FetchLargeOrdersOptions = {}): Promise<LargeOrdersSnapshot> {
    if (!this.enabled) {
      throw new Error('coinglass provider is disabled (set provider-coinglass config.enabled=true)')
    }
    return this.client.getLargeOrders(symbol, opts)
  }
}

export function apply(ctx: Context, config: Config): void {
  // Service constructor registers ctx.coinglass for the fiber lifetime.
  new CoinglassService(ctx, config)
}
