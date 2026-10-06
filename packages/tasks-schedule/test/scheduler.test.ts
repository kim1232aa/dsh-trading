import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskScheduler } from '../src/scheduler.js'
import { executeTaskAction } from '../src/tasks.js'
import type { ScheduledTask } from '../src/types.js'

describe('TaskScheduler', () => {
  let tempDir: string
  let scheduler: TaskScheduler

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-tasks-test-'))
    scheduler = new TaskScheduler({
      tasksFilePath: join(tempDir, 'tasks.json'),
      logsFilePath: join(tempDir, 'logs.json'),
    })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('initializes default tasks and logs', async () => {
    const tasks = await scheduler.listTasks()
    expect(tasks.length).toBeGreaterThanOrEqual(2)
    expect(tasks.some(t => t.action === 'funding_rate_check')).toBe(true)
    expect(tasks.some(t => t.action === 'watchlist_summary')).toBe(true)

    const logs = await scheduler.getLogs()
    expect(logs).toEqual([])
  })

  it('creates and retrieves a new task', async () => {
    const task = await scheduler.createTask({
      name: '每半小时突破选股',
      action: 'bullish_screen',
      intervalMinutes: 30,
    })
    expect(task.id).toMatch(/^task-/)
    expect(task.intervalMinutes).toBe(30)
    expect(task.enabled).toBe(true)

    const fetched = await scheduler.getTask(task.id)
    expect(fetched).toBeDefined()
    expect(fetched?.name).toBe('每半小时突破选股')
  })

  it('removes a task by id', async () => {
    const task = await scheduler.createTask({
      name: '临时监控',
      action: 'custom',
      intervalMinutes: 15,
    })
    const removed = await scheduler.removeTask(task.id)
    expect(removed).toBe(true)

    const fetched = await scheduler.getTask(task.id)
    expect(fetched).toBeUndefined()
  })

  it('toggles task enabled state', async () => {
    const task = await scheduler.createTask({
      name: '开关测试任务',
      action: 'custom',
      intervalMinutes: 60,
    })
    const disabled = await scheduler.toggleTask(task.id, false)
    expect(disabled?.enabled).toBe(false)

    const enabled = await scheduler.toggleTask(task.id, true)
    expect(enabled?.enabled).toBe(true)
  })

  it('records execution and updates task status and logs', async () => {
    const task = await scheduler.createTask({
      name: '执行测试任务',
      action: 'custom',
      intervalMinutes: 10,
    })

    const log = await scheduler.recordExecution(
      task,
      'success',
      '任务测试输出结果正常',
      120,
    )

    expect(log.taskId).toBe(task.id)
    expect(log.status).toBe('success')
    expect(log.durationMs).toBe(120)

    const updatedTask = await scheduler.getTask(task.id)
    expect(updatedTask?.lastStatus).toBe('success')
    expect(updatedTask?.lastResult).toContain('正常')

    const logs = await scheduler.getLogs(task.id)
    expect(logs.length).toBe(1)
    expect(logs[0]?.output).toBe('任务测试输出结果正常')
  })

  it('executes built-in actions safely', async () => {
    const dummyTask: ScheduledTask = {
      id: 'dummy-1',
      name: '费率巡检',
      action: 'funding_rate_check',
      intervalMinutes: 60,
      enabled: true,
      createdAt: new Date().toISOString(),
      nextRunAt: new Date().toISOString(),
    }

    const res1 = await executeTaskAction(dummyTask)
    expect(res1.status).toBe('success')
    expect(res1.output).toContain('资金费率')

    const res2 = await executeTaskAction({
      ...dummyTask,
      action: 'watchlist_summary',
    })
    expect(res2.status).toBe('success')
    expect(res2.output).toContain('自选股')

    const res3 = await executeTaskAction({
      ...dummyTask,
      action: 'bullish_screen',
    })
    expect(res3.status).toBe('success')
    expect(res3.output).toContain('选股扫描')
  })
})
