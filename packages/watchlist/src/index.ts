/**
 * Watchlist Cordis plugin for dsh-trading.
 * @module @dsh-trading/watchlist
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type z from '@deepseek-ai/schemastery'
import { WatchlistStore } from './store.js'

export * from './types.js'
export * from './store.js'

export interface Config {
  storePath: string
}

export const name = 'watchlist'
export const inject = ['tools']

export function apply(ctx: Context, config: Config): void {
  const storePath = resolve(process.cwd(), config.storePath ?? './data/watchlist.json')
  const store = new WatchlistStore({ filePath: storePath })

  ctx.tools.register(
    defineTool({
      name: 'get_watchlist',
      description: 'Get current watchlist items, optionally filtered by group (e.g. 加密货币, A股核心, 观察池).',
      parameters: {
        group: { type: 'string', description: 'Optional watchlist group name to filter by' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true },
            groups: { type: 'json', required: true },
            count: { type: 'integer', required: true },
            items: { type: 'json', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const groupFilter = typeof args.group === 'string' ? args.group : undefined
        const groups = await store.listGroups()
        const items = await store.listItems(groupFilter)
        const summary = `### 📋 自选股列表 (${items.length} 个标的)\n` +
          (items.length === 0
            ? `*暂无${groupFilter ? ` [${groupFilter}] ` : ''}标的*`
            : items.map(it => `- **${it.symbol}** [${it.group}]${it.notes ? ` - ${it.notes}` : ''} (添加于 ${it.addedAt.slice(0, 10)})`).join('\n'))

        return {
          summary,
          groups: groups as any,
          count: items.length,
          items: items as any,
        }
      },
      presentCall: args => ({
        card: 'generic',
        title: 'Watchlist Items',
        kind: 'other',
        rawInput: args,
      }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'add_to_watchlist',
      description: 'Add or update a trading instrument symbol in the watchlist.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'Symbol (e.g. BTCUSDT, ETHUSDT, 600519, sh000001, AAPL)' },
        group: { type: 'string', description: 'Group name (e.g. 自选, 加密货币, A股核心, 观察池). Defaults to 自选' },
        notes: { type: 'string', description: 'Optional personal notes or investment thesis' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true },
            item: { type: 'json', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const sym = String(args.symbol ?? '').trim()
        const grp = typeof args.group === 'string' ? args.group.trim() : undefined
        const notes = typeof args.notes === 'string' ? args.notes.trim() : undefined

        const item = await store.addItem({
          symbol: sym,
          group: grp,
          notes,
        })
        const summary = `✅ 已成功将标的 **${item.symbol}** 加入自选分组 **[${item.group}]**${item.notes ? `（备注: ${item.notes}）` : ''}。`

        return {
          summary,
          item: item as any,
        }
      },
      presentCall: args => ({
        card: 'generic',
        title: 'Add to Watchlist',
        kind: 'other',
        rawInput: args,
      }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'remove_from_watchlist',
      description: 'Remove a trading instrument symbol from the watchlist.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'Symbol to remove' },
        group: { type: 'string', description: 'Optional specific group to remove from. If omitted, removes from all groups' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true },
            removed: { type: 'boolean', required: true },
            symbol: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const sym = String(args.symbol ?? '').trim()
        const grp = typeof args.group === 'string' ? args.group.trim() : undefined
        const removed = await store.removeItem(sym, grp)
        const summary = removed
          ? `🗑️ 已将标的 **${sym.toUpperCase()}** 从自选${grp ? ` [${grp}] ` : ''}中移除。`
          : `⚠️ 未在自选列表中找到标的 **${sym.toUpperCase()}**。`

        return {
          summary,
          removed,
          symbol: sym.toUpperCase(),
        }
      },
      presentCall: args => ({
        card: 'generic',
        title: 'Remove from Watchlist',
        kind: 'other',
        rawInput: args,
      }),
    }),
  )
}
