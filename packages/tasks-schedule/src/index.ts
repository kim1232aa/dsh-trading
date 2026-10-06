/**
 * `@dsh-trading/tasks-schedule`: Automated active research and market monitoring scheduled tasks.
 * @module @dsh-trading/tasks-schedule
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MarketData } from '@dsh-trading/market-data'
import { TaskScheduler } from './scheduler.js'
import { executeTaskAction } from './tasks.js'
import type { TaskAction } from './types.js'

export type * from './types.js'
export { TaskScheduler } from './scheduler.js'

export interface Config {
  tasksFilePath?: string
  logsFilePath?: string
}

export const name = 'tasks-schedule'
export const inject = {
  required: ['tools'],
  optional: ['marketData'],
} as const

export function apply(ctx: Context, config: Config = {}): void {
  const tasksFilePath = resolve(process.cwd(), config.tasksFilePath ?? './data/tasks.json')
  const logsFilePath = resolve(process.cwd(), config.logsFilePath ?? './data/task-logs.json')

  const scheduler = new TaskScheduler({
    tasksFilePath,
    logsFilePath,
  })

  // Tool 1: list_scheduled_tasks
  ctx.tools.register(
    defineTool({
      name: 'list_scheduled_tasks',
      description: '查看当前所有注册的定时投研与行情监控任务，包括执行周期、启用状态和下次运行时间。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true },
            total: { type: 'integer', required: true },
            tasks: { type: 'json', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      isConcurrencySafe: () => true,
      async execute() {
        const tasks = await scheduler.listTasks()
        const summary =
          `### ⏱️ 定时投研任务列表 (${tasks.length} 个)\n` +
          (tasks.length === 0
            ? '*暂无配置的定时任务*'
            : tasks
                .map(
                  t =>
                    `- **${t.name}** [ID: \`${t.id}\` | 动作: \`${t.action}\`]\n` +
                    `  周期: 每 ${t.intervalMinutes} 分钟 | 状态: ${t.enabled ? '🟢 已启用' : '⚪ 已停用'}\n` +
                    `  下次运行: ${t.nextRunAt.slice(0, 19).replace('T', ' ')}${
                      t.lastStatus ? ` | 上次执行: ${t.lastStatus === 'success' ? '✅' : '❌'}` : ''
                    }`,
                )
                .join('\n'))

        return {
          summary,
          total: tasks.length,
          tasks: tasks as any,
        }
      },
    }),
  )

  // Tool 2: create_scheduled_task
  ctx.tools.register(
    defineTool({
      name: 'create_scheduled_task',
      description: '创建新的定时投研/行情监控任务（如：资金费率巡检、自选股复盘、全市场选股）。',
      parameters: {
        name: { type: 'string', required: true, description: '任务名称，如“每小时ETH资金费率巡检”' },
        action: {
          type: 'string',
          required: true,
          enum: ['watchlist_summary', 'funding_rate_check', 'bullish_screen', 'custom'],
          description: '执行动作类型',
        },
        intervalMinutes: {
          type: 'integer',
          description: '执行间隔分钟数（默认 60）',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true },
            task: { type: 'json', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const action = args.action as TaskAction
        const interval = typeof args.intervalMinutes === 'number' ? args.intervalMinutes : 60
        const task = await scheduler.createTask({
          name: args.name,
          action,
          intervalMinutes: interval,
        })

        const summary = `✅ 定时投研任务 [${task.name}] 创建成功！\n- ID: \`${task.id}\`\n- 动作: \`${task.action}\`\n- 周期: 每 ${task.intervalMinutes} 分钟\n- 下次计划: ${task.nextRunAt.slice(0, 19).replace('T', ' ')}`

        return {
          summary,
          task: task as any,
        }
      },
    }),
  )

  // Tool 3: remove_scheduled_task
  ctx.tools.register(
    defineTool({
      name: 'remove_scheduled_task',
      description: '删除指定的定时投研任务。',
      parameters: {
        id: { type: 'string', required: true, description: '待删除的任务 ID' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true },
            success: { type: 'boolean', required: true },
            id: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const success = await scheduler.removeTask(args.id)
        const summary = success
          ? `🗑️ 成功删除定时投研任务 [ID: \`${args.id}\`]`
          : `⚠️ 未找到定时任务 [ID: \`${args.id}\`]`

        return {
          summary,
          success,
          id: args.id,
        }
      },
    }),
  )

  // Tool 4: run_scheduled_task_now
  ctx.tools.register(
    defineTool({
      name: 'run_scheduled_task_now',
      description: '立即手动触发并执行某个定时投研任务，并持久化执行日志。',
      parameters: {
        id: { type: 'string', required: true, description: '要立即执行的任务 ID' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true },
            success: { type: 'boolean', required: true },
            taskName: { type: 'string', required: true },
            durationMs: { type: 'integer', required: true },
            output: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const task = await scheduler.getTask(args.id)
        if (!task) {
          return {
            summary: `❌ 未找到 ID 为 [${args.id}] 的定时任务`,
            success: false,
            taskName: '未知',
            durationMs: 0,
            output: '任务不存在',
          }
        }

        const start = Date.now()
        const res = await executeTaskAction(task, {
          marketData: ctx.marketData as MarketData | undefined,
        })
        const durationMs = Date.now() - start

        await scheduler.recordExecution(task, res.status, res.output, durationMs, res.error)

        const summary =
          `⚡ **立即执行任务 [${task.name}] 完成** (${durationMs}ms):\n` +
          `状态: ${res.status === 'success' ? '✅ 成功' : '❌ 失败'}\n\n` +
          `${res.output}`

        return {
          summary,
          success: res.status === 'success',
          taskName: task.name,
          durationMs,
          output: res.output,
        }
      },
    }),
  )

  // Tool 5: get_scheduled_task_logs
  ctx.tools.register(
    defineTool({
      name: 'get_scheduled_task_logs',
      description: '查看定时投研任务的最近执行历史记录与简报输出。',
      parameters: {
        taskId: { type: 'string', description: '可选过滤特定任务 ID' },
        limit: { type: 'integer', description: '返回最大日志条数（默认 10）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true },
            total: { type: 'integer', required: true },
            logs: { type: 'json', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const limit = typeof args.limit === 'number' ? args.limit : 10
        const taskId = typeof args.taskId === 'string' ? args.taskId : undefined
        const logs = await scheduler.getLogs(taskId, limit)

        const summary =
          `### 📜 定时任务执行日志 (${logs.length} 条)\n` +
          (logs.length === 0
            ? '*暂无执行日志*'
            : logs
                .map(
                  l =>
                    `- **[${l.status === 'success' ? '✅ 成功' : '❌ 失败'}] ${l.taskName}** (${l.durationMs}ms, ${l.executedAt.slice(0, 19).replace('T', ' ')})\n` +
                    `  ${l.output.replace(/\n/g, ' ')}`,
                )
                .join('\n'))

        return {
          summary,
          total: logs.length,
          logs: logs as any,
        }
      },
    }),
  )
}

export default { name, inject, apply }
