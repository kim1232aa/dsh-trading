/**
 * Persistent task scheduler and execution logger.
 * @module @dsh-trading/tasks-schedule
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ScheduledTask, TaskAction, TaskExecutionLog, TasksState } from './types.js'

export interface TaskSchedulerOptions {
  tasksFilePath: string
  logsFilePath: string
}

export class TaskScheduler {
  readonly tasksFilePath: string
  readonly logsFilePath: string

  constructor(options: TaskSchedulerOptions) {
    this.tasksFilePath = options.tasksFilePath
    this.logsFilePath = options.logsFilePath
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.tasksFilePath), { recursive: true })
    await mkdir(dirname(this.logsFilePath), { recursive: true })

    try {
      await readFile(this.tasksFilePath, 'utf-8')
    } catch {
      const now = new Date()
      const nextRun = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
      const defaultState: TasksState = {
        tasks: [
          {
            id: 'task-funding-monitor',
            name: '永续合约极端资金费率与持仓监控',
            action: 'funding_rate_check',
            intervalMinutes: 60,
            enabled: true,
            createdAt: now.toISOString(),
            nextRunAt: nextRun,
            params: { thresholdPct: 0.03 },
          },
          {
            id: 'task-watchlist-summary',
            name: '自选股定时复盘与行情快照',
            action: 'watchlist_summary',
            intervalMinutes: 240,
            enabled: true,
            createdAt: now.toISOString(),
            nextRunAt: nextRun,
          },
        ],
      }
      await this.atomicWriteTasks(defaultState)
    }

    try {
      await readFile(this.logsFilePath, 'utf-8')
    } catch {
      await this.atomicWriteLogs([])
    }
  }

  private async atomicWriteTasks(state: TasksState): Promise<void> {
    const tmp = `${this.tasksFilePath}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
    await rename(tmp, this.tasksFilePath)
  }

  private async atomicWriteLogs(logs: TaskExecutionLog[]): Promise<void> {
    const tmp = `${this.logsFilePath}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(logs, null, 2), 'utf-8')
    await rename(tmp, this.logsFilePath)
  }

  async listTasks(): Promise<ScheduledTask[]> {
    await this.init()
    try {
      const raw = await readFile(this.tasksFilePath, 'utf-8')
      const state = JSON.parse(raw) as TasksState
      return Array.isArray(state.tasks) ? state.tasks : []
    } catch {
      return []
    }
  }

  async getTask(id: string): Promise<ScheduledTask | undefined> {
    const tasks = await this.listTasks()
    return tasks.find(t => t.id === id)
  }

  async createTask(params: {
    name: string
    action: TaskAction
    intervalMinutes: number
    params?: Record<string, unknown> | undefined
  }): Promise<ScheduledTask> {
    const tasks = await this.listTasks()
    const now = new Date()
    const interval = Math.max(1, Math.round(params.intervalMinutes))
    const nextRun = new Date(now.getTime() + interval * 60 * 1000).toISOString()

    const task: ScheduledTask = {
      id: `task-${randomUUID().slice(0, 8)}`,
      name: params.name.trim(),
      action: params.action,
      intervalMinutes: interval,
      enabled: true,
      createdAt: now.toISOString(),
      nextRunAt: nextRun,
      params: params.params,
    }

    tasks.push(task)
    await this.atomicWriteTasks({ tasks })
    return task
  }

  async removeTask(id: string): Promise<boolean> {
    const tasks = await this.listTasks()
    const filtered = tasks.filter(t => t.id !== id)
    if (filtered.length !== tasks.length) {
      await this.atomicWriteTasks({ tasks: filtered })
      return true
    }
    return false
  }

  async toggleTask(id: string, enabled: boolean): Promise<ScheduledTask | undefined> {
    const tasks = await this.listTasks()
    const target = tasks.find(t => t.id === id)
    if (!target) return undefined

    target.enabled = enabled
    if (enabled) {
      const now = new Date()
      target.nextRunAt = new Date(now.getTime() + target.intervalMinutes * 60 * 1000).toISOString()
    }
    await this.atomicWriteTasks({ tasks })
    return target
  }

  async recordExecution(
    task: ScheduledTask,
    status: 'success' | 'failed',
    output: string,
    durationMs: number,
    error?: string,
  ): Promise<TaskExecutionLog> {
    const now = new Date()
    const log: TaskExecutionLog = {
      id: randomUUID(),
      taskId: task.id,
      taskName: task.name,
      action: task.action,
      executedAt: now.toISOString(),
      durationMs,
      status,
      output,
      error,
    }

    // Update task status and next run time
    const tasks = await this.listTasks()
    const target = tasks.find(t => t.id === task.id)
    if (target) {
      target.lastRunAt = now.toISOString()
      target.lastStatus = status
      target.lastResult = output.slice(0, 200)
      target.nextRunAt = new Date(now.getTime() + target.intervalMinutes * 60 * 1000).toISOString()
      await this.atomicWriteTasks({ tasks })
    }

    // Append to logs (keep last 100)
    const logs = await this.getLogs(undefined, 200)
    logs.unshift(log)
    await this.atomicWriteLogs(logs.slice(0, 100))
    return log
  }

  async getLogs(taskId?: string | undefined, limit = 20): Promise<TaskExecutionLog[]> {
    await this.init()
    try {
      const raw = await readFile(this.logsFilePath, 'utf-8')
      const logs = JSON.parse(raw) as TaskExecutionLog[]
      if (!Array.isArray(logs)) return []
      if (!taskId) return logs.slice(0, limit)
      return logs.filter(l => l.taskId === taskId).slice(0, limit)
    } catch {
      return []
    }
  }
}
