import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KnowledgeStore } from '../src/store.js'

describe('KnowledgeStore', () => {
  let tempDir: string
  let filePath: string
  let store: KnowledgeStore

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-knowledge-test-'))
    filePath = join(tempDir, 'knowledge.json')
    store = new KnowledgeStore({ filePath })
    await store.init()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('records research theses with status active and atomic persistence', async () => {
    const t1 = await store.recordThesis({
      symbol: 'ETHUSDT',
      title: '2720 UTAD假突破做空',
      thesis: '15:00冲高2725留7美金长上影，庄家清算流动性完成，进入派发下跌',
      direction: 'bear',
      timeframe: '5m',
      invalidationCondition: '收盘站上2726.00',
      targetPrice: 2690.40,
      tags: ['假突破', 'UTAD', '流动性掠夺'],
    })

    expect(t1.id).toMatch(/^th_/)
    expect(t1.symbol).toBe('ETHUSDT')
    expect(t1.direction).toBe('bear')
    expect(t1.status).toBe('active')
    expect(t1.tags).toEqual(['假突破', 'UTAD', '流动性掠夺'])

    const all = await store.queryTheses()
    expect(all).toHaveLength(1)
    expect(all[0]?.title).toBe('2720 UTAD假突破做空')
  })

  it('filters theses by symbol, tag, and status', async () => {
    await store.recordThesis({
      symbol: 'ETHUSDT',
      title: 'ETH 假突破',
      thesis: '派发走势',
      direction: 'bear',
      timeframe: '15m',
      invalidationCondition: '2726',
      tags: ['假突破'],
    })
    await store.recordThesis({
      symbol: 'BTCUSDT',
      title: 'BTC 均线多头',
      thesis: '日线突破',
      direction: 'bull',
      timeframe: '1d',
      invalidationCondition: '跌破60000',
      tags: ['趋势突破'],
    })

    const ethTheses = await store.queryTheses({ symbol: 'ETHUSDT' })
    expect(ethTheses).toHaveLength(1)
    expect(ethTheses[0]?.symbol).toBe('ETHUSDT')

    const breakOutTheses = await store.queryTheses({ tag: '假突破' })
    expect(breakOutTheses).toHaveLength(1)
    expect(breakOutTheses[0]?.symbol).toBe('ETHUSDT')

    const bullTheses = await store.queryTheses({ direction: 'bull' })
    expect(bullTheses).toHaveLength(1)
    expect(bullTheses[0]?.symbol).toBe('BTCUSDT')
  })

  it('updates thesis status and records invalidation reason', async () => {
    const t = await store.recordThesis({
      symbol: '600519',
      title: '茅台价值回归',
      thesis: '估值跌破合理区间下沿',
      direction: 'bull',
      timeframe: '1d',
      invalidationCondition: '跌破1300',
      tags: ['价值投资'],
    })

    const updated = await store.updateThesisStatus(t.id, 'validated')
    expect(updated?.status).toBe('validated')

    const invalidated = await store.updateThesisStatus(t.id, 'invalidated', '突发宏观利空击穿止损位')
    expect(invalidated?.status).toBe('invalidated')
    expect(invalidated?.invalidationReason).toBe('突发宏观利空击穿止损位')
  })

  it('aggregates tags into tagHubs with counts', async () => {
    await store.recordThesis({
      symbol: 'ETHUSDT',
      title: 'ETH 1',
      thesis: '...',
      direction: 'bear',
      timeframe: '5m',
      invalidationCondition: '...',
      tags: ['假突破', '高频'],
    })
    await store.recordThesis({
      symbol: 'SOLUSDT',
      title: 'SOL 1',
      thesis: '...',
      direction: 'bear',
      timeframe: '5m',
      invalidationCondition: '...',
      tags: ['假突破', 'M顶'],
    })

    const tagHubs = await store.listTags()
    expect(tagHubs).toEqual([
      { tag: '假突破', count: 2 },
      { tag: '高频', count: 1 },
      { tag: 'M顶', count: 1 },
    ])
  })
})
