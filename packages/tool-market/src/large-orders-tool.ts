/**
 * Model-facing large_orders tool over CoinGlass capi (via provider-coinglass).
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  CoinglassCapi,
  renderLargeOrders,
} from '@dsh-trading/provider-coinglass'
import type { CoinglassService, LargeOrdersSnapshot } from '@dsh-trading/provider-coinglass'

async function pullLargeOrders(
  ctx: Context,
  symbol: string,
  opts: {
    hours?: number
    top?: number
    venue?: string
    minUsd?: number
    exchange?: string
    market?: 'perp' | 'spot'
    status?: 'active' | 'all' | 'revoked'
    currentPrice?: number
    maxDistancePct?: number
    balanced?: boolean
  },
): Promise<LargeOrdersSnapshot> {
  let service: CoinglassService | undefined
  try {
    service = (ctx as Context & { coinglass?: CoinglassService }).coinglass
  } catch {
    service = undefined
  }
  const queryOpts = {
    ...(opts.hours !== undefined ? { hours: opts.hours } : {}),
    ...(opts.top !== undefined ? { top: opts.top } : {}),
    ...(opts.venue !== undefined ? { venue: opts.venue } : {}),
    ...(opts.minUsd !== undefined ? { minUsd: opts.minUsd } : {}),
    ...(opts.status !== undefined ? { status: opts.status } : {}),
    ...(opts.currentPrice !== undefined ? { currentPrice: opts.currentPrice } : {}),
    ...(opts.maxDistancePct !== undefined ? { maxDistancePct: opts.maxDistancePct } : {}),
    ...(opts.balanced !== undefined ? { balanced: opts.balanced } : {}),
  }
  if (service) {
    return service.getLargeOrders(symbol, queryOpts)
  }
  const client = new CoinglassCapi({
    ...(opts.exchange !== undefined ? { defaultExchange: opts.exchange } : {}),
    ...(opts.market !== undefined ? { defaultMarket: opts.market } : {}),
  })
  return client.getLargeOrders(symbol, queryOpts)
}

/** Register the large_orders research tool. */
export function registerLargeOrdersTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'large_orders',
    description:
      'Fetch large resting limit-order walls (大额挂单墙) from CoinGlass public capi for a crypto pair. '
      + 'Maps BTCUSDT → Binance_BTCUSDT by default; use exchange/market or okx:BTCUSDT / spot:ETHUSDT forms. '
      + 'Returns top buy/sell walls with USD size and age, plus optional venue statistics. Research-only.',
    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: 'Pair as list_symbols reports it (BTCUSDT), or CoinGlass form (Binance_BTCUSDT), or exchange:PAIR / spot:PAIR.',
      },
      hours: {
        type: 'number',
        description: 'Lookback window in hours (default 72).',
      },
      top: {
        type: 'integer',
        description: 'Max walls to return, sorted by current USD (default 20).',
      },
      venue: {
        type: 'string',
        description: 'Filter flattened walls to one venue name, e.g. Binance or OKX.',
      },
      min_usd: {
        type: 'number',
        description: 'Minimum current USD notional; e.g. 1000000 for $100万. Walls below this are dropped before top-N.',
      },
      exchange: {
        type: 'string',
        description: 'Default exchange label when mapping bare pairs (default Binance).',
      },
      market: {
        type: 'string',
        enum: ['perp', 'spot'],
        description: 'perp (default) or spot when mapping bare pairs.',
      },
      status: {
        type: 'string',
        enum: ['active', 'all', 'revoked'],
        description: "Order status filter: 'active' (default, resting limit orders only), 'all' (active + historical cancelled/filled), or 'revoked' (historical only).",
      },
      current_price: {
        type: 'number',
        description: 'Current reference price for proximity filtering. Distant orders beyond max_distance_pct are excluded.',
      },
      max_distance_pct: {
        type: 'number',
        description: 'Maximum distance from current price as a decimal (default 0.35 = ±35%). Used when current_price is provided.',
      },
      balanced: {
        type: 'boolean',
        description: 'Whether to return a balanced list of top buy walls and sell walls (default true). When false, sorts purely by USD.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cgSymbol: { type: 'string', required: true },
          pair: { type: 'string', required: true },
          orderCount: { type: 'integer', required: true },
          rendered: { type: 'string', required: true },
          walls: { type: 'json', required: true },
          statistics: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.rendered }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const top = args.top ?? 20
      const snap = await pullLargeOrders(ctx, args.symbol, {
        ...(args.hours !== undefined ? { hours: args.hours } : {}),
        top,
        ...(args.venue !== undefined ? { venue: args.venue } : {}),
        ...(typeof args.min_usd === 'number' ? { minUsd: args.min_usd } : {}),
        ...(args.exchange !== undefined ? { exchange: args.exchange } : {}),
        ...(args.market === 'perp' || args.market === 'spot' ? { market: args.market } : {}),
        ...(args.status === 'active' || args.status === 'all' || args.status === 'revoked' ? { status: args.status } : {}),
        ...(typeof args.current_price === 'number' ? { currentPrice: args.current_price } : {}),
        ...(typeof args.max_distance_pct === 'number' ? { maxDistancePct: args.max_distance_pct } : {}),
        ...(typeof args.balanced === 'boolean' ? { balanced: args.balanced } : {}),
      })
      return {
        cgSymbol: snap.cgSymbol,
        pair: snap.pair,
        orderCount: snap.orderCount,
        rendered: renderLargeOrders(snap, top),
        // Plain records so the tool output stays JsonValue-assignable.
        walls: snap.walls.map(w => ({
          id: w.id,
          exchange: w.exchange,
          side: w.side,
          price: w.price,
          currentUsd: w.currentUsd,
          startUsd: w.startUsd,
          startAmount: w.startAmount,
          currentAmount: w.currentAmount,
          volUsd: w.volUsd,
          state: w.state,
          startTime: w.startTime,
          currentTime: w.currentTime,
          ...(w.baseAsset !== undefined ? { baseAsset: w.baseAsset } : {}),
          ...(w.market !== undefined ? { market: w.market } : {}),
        })),
        statistics: snap.statistics.map(s => ({
          exchange: s.exchange,
          bidsTotalUsd: s.bidsTotalUsd,
          asksTotalUsd: s.asksTotalUsd,
          ...(s.baseAsset !== undefined ? { baseAsset: s.baseAsset } : {}),
          ...(s.market !== undefined ? { market: s.market } : {}),
          ...(s.buyVolUsd !== undefined ? { buyVolUsd: s.buyVolUsd } : {}),
          ...(s.sellVolUsd !== undefined ? { sellVolUsd: s.sellVolUsd } : {}),
        })),
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Large orders: ${args.symbol}`,
      kind: 'read',
      rawInput: args,
    }),
  }))
}
