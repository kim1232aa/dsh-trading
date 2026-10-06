/**
 * Research knowledge graph and investment thesis repository plugin.
 * @module @dsh-trading/knowledge
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { KnowledgeStore } from './store.js'
import type { ThesisDirection, ThesisStatus } from './types.js'

export * from './types.js'
export * from './store.js'

export interface KnowledgeConfig {
  storePath?: string
}

export const Config: z<KnowledgeConfig> = z.object({
  storePath: z.string().default('./data/knowledge.json').description('Path to persistent knowledge json store file'),
})

export const name = 'knowledge'
export const inject = ['tools'] as const

export function apply(ctx: Context, config: KnowledgeConfig = {}): void {
  const filePath = resolve(process.cwd(), config.storePath ?? './data/knowledge.json')
  const store = new KnowledgeStore({ filePath })

  // 1. Tool: record_thesis
  ctx.tools.register(defineTool({
    name: 'record_thesis',
    description: 'Record an investment thesis, market hypothesis, or trading plan with clear invalidation conditions and target expectations.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Trading symbol (e.g. BTCUSDT, ETHUSDT, 600519)' },
      title: { type: 'string', required: true, description: 'Short descriptive title of the hypothesis' },
      thesis: { type: 'string', required: true, description: 'Core reasoning, market logic, Wyckoff structure, or technical setup' },
      direction: { type: 'string', required: true, description: 'Directional stance: bull, bear, or neutral' },
      timeframe: { type: 'string', required: true, description: 'Primary timeframe of this setup (e.g. 5m, 15m, 1h, 4h, 1d)' },
      invalidationCondition: { type: 'string', required: true, description: 'Observable condition or price that invalidates this thesis (stop-loss criteria)' },
      entryTrigger: { type: 'string', description: 'Observable trigger that confirms entry (optional)' },
      targetPrice: { type: 'number', description: 'Expected target take-profit price (optional)' },
      tags: { type: 'json', description: 'Array of tag strings (e.g. ["UTAD", "假突破", "流动性掠夺"])' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          symbol: { type: 'string', required: true },
          title: { type: 'string', required: true },
          direction: { type: 'string', required: true },
          status: { type: 'string', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => false,
    async execute(args, _exec) {
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : []
      const thesis = await store.recordThesis({
        symbol: args.symbol,
        title: args.title,
        thesis: args.thesis,
        direction: (args.direction as ThesisDirection) || 'neutral',
        timeframe: args.timeframe,
        invalidationCondition: args.invalidationCondition,
        entryTrigger: args.entryTrigger,
        targetPrice: args.targetPrice,
        tags,
      })

      const summary = `### 📝 投研论点已成功沉淀 [ID: \`${thesis.id}\`]\n` +
        `- **标的**: \`${thesis.symbol}\` (${thesis.timeframe})\n` +
        `- **方向**: **${thesis.direction.toUpperCase()}**\n` +
        `- **标题**: **${thesis.title}**\n` +
        `- **核心论点**: ${thesis.thesis}\n` +
        `- **失效条件(止损)**: \`${thesis.invalidationCondition}\`\n` +
        (thesis.targetPrice ? `- **目标价(止盈)**: \`${thesis.targetPrice}\`\n` : '') +
        `- **标签**: [${thesis.tags.join(', ')}]`

      return {
        id: thesis.id,
        symbol: thesis.symbol,
        title: thesis.title,
        direction: thesis.direction,
        status: thesis.status,
        summary,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Record Thesis: ${args.title} (${args.symbol})`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  // 2. Tool: query_theses
  ctx.tools.register(defineTool({
    name: 'query_theses',
    description: 'Query recorded investment hypotheses and research theses by symbol, status, tag, or direction.',
    parameters: {
      symbol: { type: 'string', description: 'Filter by symbol (e.g. ETHUSDT)' },
      status: { type: 'string', description: 'Filter by status: active, validated, invalidated, closed' },
      tag: { type: 'string', description: 'Filter by tag (e.g. 假突破)' },
      direction: { type: 'string', description: 'Filter by direction: bull, bear, neutral' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          summary: { type: 'string', required: true },
          theses: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const items = await store.queryTheses({
        symbol: args.symbol,
        status: args.status as ThesisStatus | undefined,
        tag: args.tag,
        direction: args.direction as ThesisDirection | undefined,
      })

      let summary = `### 📚 投研知识库查询结果 (${items.length} 条)\n`
      if (items.length === 0) {
        summary += '_暂无匹配的投研论点。_'
      } else {
        summary += items.map(t => {
          const statusIcon = t.status === 'active' ? '🟢进行中' : t.status === 'validated' ? '✅已验证' : t.status === 'invalidated' ? '❌已失效' : '⚪已平仓'
          return `- **[\`${t.id}\`] ${t.symbol} (${t.direction.toUpperCase()})**: **${t.title}** [${statusIcon}]\n  - 论点: ${t.thesis}\n  - 失效: \`${t.invalidationCondition}\``
        }).join('\n')
      }

      return {
        count: items.length,
        summary,
        theses: items as any,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Query Theses: ${args.symbol ?? 'all'}`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  // 3. Tool: update_thesis_status
  ctx.tools.register(defineTool({
    name: 'update_thesis_status',
    description: 'Update the validation status of a recorded thesis when price reaches target or invalidation condition is triggered.',
    parameters: {
      id: { type: 'string', required: true, description: 'Thesis ID (e.g. th_123456_abcdef)' },
      status: { type: 'string', required: true, description: 'New status: active, validated, invalidated, or closed' },
      invalidationReason: { type: 'string', description: 'Explanation or post-mortem of why the market invalidated this setup' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => false,
    async execute(args, _exec) {
      const updated = await store.updateThesisStatus(
        args.id,
        args.status as ThesisStatus,
        args.invalidationReason,
      )

      if (!updated) {
        throw new Error(`Thesis with ID "${args.id}" not found.`)
      }

      const summary = `### 🔄 论点状态已更新 [ID: \`${updated.id}\`]\n` +
        `- **标的**: \`${updated.symbol}\` (${updated.title})\n` +
        `- **新状态**: **${updated.status.toUpperCase()}**\n` +
        (updated.invalidationReason ? `- **复盘原因**: ${updated.invalidationReason}\n` : '')

      return {
        id: updated.id,
        status: updated.status,
        summary,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Update Thesis: ${args.id} -> ${args.status}`,
      kind: 'other',
      rawInput: args,
    }),
  }))
}
