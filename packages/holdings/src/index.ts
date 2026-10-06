/**
 * Two-zone portfolio holdings and trade ledger plugin.
 * Provides staging safety zone, weighted average cost basis accounting,
 * and tools for tracking positions and trades.
 * @module @dsh-trading/holdings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MarketData } from '@dsh-trading/market-data'
import {
  createEmptyPosition,
  inferAssetClassAndCurrency,
  summarizePortfolio,
  updatePositionMarketValue,
} from './ledger.js'
import { HoldingsStore } from './store.js'
import type { Currency, HoldingPosition, StagedTrade, TradeSide } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    marketData: MarketData
  }
}

export * from './types.js'
export * from './ledger.js'
export * from './store.js'

export const name = 'holdings'
export const inject = ['tools', 'marketData']

export interface Config {
  storeDir: string
}

export const Config: z<Config> = z.object({
  storeDir: z.string().default('./data/holdings'),
}) as unknown as z<Config>

export function apply(ctx: Context, config: Config): void {
  const store = new HoldingsStore({ baseDir: config.storeDir })

  ctx.tools.register(defineTool({
    name: 'get_holdings',
    description: 'Query user portfolio holdings, asset positions, average cost basis, live market value, unrealized PnL, and pending staged trades awaiting review. Automatically fetches live prices.',
    parameters: {
      symbols: { type: 'array', items: { type: 'string' }, description: 'Optional list of symbols to filter by. Omit to query all holdings.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true },
          positions: { type: 'json', required: true },
          totals: { type: 'json', required: true },
          stagedTradesCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      let positions = await store.getPositions()
      if (args.symbols && args.symbols.length > 0) {
        const filterSet = new Set(args.symbols.map(s => s.toUpperCase()))
        positions = positions.filter(p => filterSet.has(p.symbol.toUpperCase()))
      }

      // Attempt to fetch current market price for each position
      const priceMap: Record<string, number> = {}
      for (const pos of positions) {
        try {
          const provider = ctx.marketData.provider()
          const candles = await provider.getOhlcv({
            symbol: pos.symbol,
            timeframe: '1d',
            limit: 2,
          })
          if (candles && candles.length > 0) {
            const latest = candles[candles.length - 1]
            if (latest?.close) {
              priceMap[pos.symbol] = latest.close
            }
          }
        } catch {
          // If live price fetch fails for a symbol, keep existing cached price
        }
      }

      if (Object.keys(priceMap).length > 0) {
        await store.updateMarketPrices(priceMap)
        positions = await store.getPositions()
      }

      const summary = await store.getPortfolioSummary()
      const lines: string[] = []
      lines.push(`【投资组合持仓】包含 ${positions.length} 个持仓品种，${summary.stagedTradesCount} 笔待确认交易：`)

      if (positions.length === 0) {
        lines.push('当前暂无任何持仓。可通过 stage_trade 暂存或录入交易。')
      } else {
        for (const p of positions) {
          const pnlSign = (p.unrealizedPnl ?? 0) >= 0 ? '+' : ''
          const pnlStr = p.unrealizedPnl !== undefined
            ? ` | 盈亏: ${pnlSign}${p.unrealizedPnl} ${p.currency} (${pnlSign}${p.unrealizedPnlPct}%)`
            : ''
          const priceStr = p.currentPrice !== undefined ? ` | 现价: ${p.currentPrice}` : ''
          const mvalStr = p.marketValue !== undefined ? ` | 市值: ${p.marketValue} ${p.currency}` : ''
          lines.push(`• ${p.symbol}: 持仓 ${p.quantity} | 均价 ${p.averageCost} ${p.currency}${priceStr}${mvalStr}${pnlStr}`)
        }
      }

      if (summary.stagedTradesCount > 0) {
        lines.push(`\n提示: 尚有 ${summary.stagedTradesCount} 笔交易处于待确认区 (Staging Zone)，需人工核对后 commit_trade 入账。`)
      }

      return {
        summary: lines.join('\n'),
        positions: positions as any,
        totals: {
          marketValue: summary.totalMarketValue,
          unrealizedPnl: summary.totalUnrealizedPnl,
          realizedPnl: summary.totalRealizedPnl,
        } as any,
        stagedTradesCount: summary.stagedTradesCount,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Portfolio Holdings & Positions',
      kind: 'other',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'stage_trade',
    description: 'Stage a candidate trade execution in the staging zone for review before committing to the official ledger. Safe: uncommitted trades do not alter portfolio balances.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Asset symbol ticker (e.g. ETHUSDT, 600519).' },
      side: { type: 'string', required: true, enum: ['buy', 'sell', 'long', 'short'], description: 'Trade side.' },
      quantity: { type: 'number', required: true, description: 'Trade quantity.' },
      price: { type: 'number', required: true, description: 'Execution price per unit.' },
      currency: { type: 'string', enum: ['CNY', 'USD', 'USDT'], description: 'Quote currency (defaults to inferred).' },
      fee: { type: 'number', description: 'Commission fee paid.' },
      notes: { type: 'string', description: 'Optional trade context, reason, or strategy tag.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true },
          trade: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const inferred = inferAssetClassAndCurrency(args.symbol)
      const trade = await store.stageTrade({
        symbol: args.symbol,
        side: args.side as TradeSide,
        quantity: args.quantity,
        price: args.price,
        currency: (args.currency as Currency) ?? inferred.currency,
        fee: args.fee,
        notes: args.notes,
      })

      return {
        summary: `已将交易暂存至待确认区 (Trade ID: ${trade.id}): ${trade.side.toUpperCase()} ${trade.quantity} ${trade.symbol} @ ${trade.price} ${trade.currency}。请核对无误后调用 commit_trade 入账。`,
        trade: trade as any,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Stage Trade: ${args.side} ${args.quantity} ${args.symbol}`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'commit_trade',
    description: 'Confirm and commit a staged trade into the official permanent portfolio ledger, updating average cost basis and realized PnL.',
    parameters: {
      tradeId: { type: 'string', required: true, description: 'The unique trade ID of the staged trade.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true },
          position: { type: 'json', required: true },
          realizedPnlDelta: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const { trade, position, realizedPnlDelta } = await store.commitTrade(args.tradeId)
      const pnlMsg = realizedPnlDelta !== 0
        ? ` | 本次变动已实现盈亏: ${realizedPnlDelta > 0 ? '+' : ''}${realizedPnlDelta} ${trade.currency}`
        : ''
      return {
        summary: `交易成功入账 (ID: ${trade.id}): ${trade.side.toUpperCase()} ${trade.quantity} ${trade.symbol}。当前最新持仓: ${position.quantity} ${position.symbol}，持仓均价: ${position.averageCost} ${position.currency}${pnlMsg}。`,
        position: position as any,
        realizedPnlDelta,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Commit Trade: ${args.tradeId}`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'discard_trade',
    description: 'Discard a candidate trade from the staging zone without modifying portfolio balances.',
    parameters: {
      tradeId: { type: 'string', required: true, description: 'The unique trade ID of the staged trade.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true },
          tradeId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      await store.discardTrade(args.tradeId)
      return {
        summary: `已作废待确认交易 (Trade ID: ${args.tradeId})，账本持仓未做任何修改。`,
        tradeId: args.tradeId,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Discard Trade: ${args.tradeId}`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'list_trades',
    description: 'List trade executions: pending candidates in the staging zone and committed trade history.',
    parameters: {
      status: { type: 'string', enum: ['staged', 'committed', 'all'], description: 'Filter by trade status (default "staged").' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          trades: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const stagedTrades = await store.listStagedTrades()
      const lines: string[] = []
      lines.push(`【交易记录列表】待确认区 (Staging Zone) 共 ${stagedTrades.length} 笔：`)
      for (const t of stagedTrades) {
        lines.push(`• [${t.status.toUpperCase()}] ${t.id.slice(0, 8)}...: ${t.side.toUpperCase()} ${t.quantity} ${t.symbol} @ ${t.price} ${t.currency} (${t.stagedAt})`)
      }
      return {
        summary: lines.join('\n'),
        count: stagedTrades.length,
        trades: stagedTrades as any,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'List Trades',
      kind: 'other',
      rawInput: args,
    }),
  }))
}
