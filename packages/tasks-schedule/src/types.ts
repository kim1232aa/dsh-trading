/**
 * Types and contracts for scheduled active research tasks.
 * @module @dsh-trading/tasks-schedule
 */

export type TaskAction =
  | 'watchlist_summary'
  | 'funding_rate_check'
  | 'bullish_screen'
  | 'custom'

export interface ScheduledTask {
  id: string
  name: string
  action: TaskAction
  /** Interval in minutes between consecutive runs (min 1). */
  intervalMinutes: number
  enabled: boolean
  createdAt: string
  lastRunAt?: string | undefined
  nextRunAt: string
  lastStatus?: 'success' | 'failed' | undefined
  lastResult?: string | undefined
  /** Optional params specific to action (e.g. threshold, group) */
  params?: Record<string, unknown> | undefined
}

export interface TaskExecutionLog {
  id: string
  taskId: string
  taskName: string
  action: TaskAction
  executedAt: string
  durationMs: number
  status: 'success' | 'failed'
  output: string
  error?: string | undefined
}

export interface TasksState {
  tasks: ScheduledTask[]
}
