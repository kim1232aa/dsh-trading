import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WatchlistStore } from '../src/store.js'

describe('WatchlistStore', () => {
  const testDir = resolve(process.cwd(), 'temp-test-watchlist')
  const testFile = resolve(testDir, 'watchlist.json')
  let store: WatchlistStore

  beforeEach(async () => {
    store = new WatchlistStore({ filePath: testFile })
    await store.init()
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('initializes with default groups and preset items', async () => {
    const groups = await store.listGroups()
    expect(groups).toContain('自选')
    expect(groups).toContain('加密货币')
    expect(groups).toContain('A股核心')

    const items = await store.listItems()
    expect(items.length).toBeGreaterThanOrEqual(4)
    const btc = items.find(it => it.symbol === 'BTCUSDT')
    expect(btc).toBeDefined()
    expect(btc?.group).toBe('加密货币')
  })

  it('adds new items to default and custom groups', async () => {
    const item = await store.addItem({
      symbol: 'SOLUSDT',
      group: '加密货币',
      notes: '高性能公链',
    })
    expect(item.symbol).toBe('SOLUSDT')
    expect(item.notes).toBe('高性能公链')

    const custom = await store.addItem({
      symbol: 'TSLA',
      group: '美股成长',
      notes: '特斯拉汽车与机器人',
    })
    expect(custom.symbol).toBe('TSLA')
    expect(custom.group).toBe('美股成长')

    const groups = await store.listGroups()
    expect(groups).toContain('美股成长')

    const usItems = await store.listItems('美股成长')
    expect(usItems).toHaveLength(1)
    expect(usItems[0]?.symbol).toBe('TSLA')
  })

  it('updates existing item notes and preserves addedAt', async () => {
    const original = await store.addItem({
      symbol: '000001',
      group: 'A股核心',
      notes: '平安银行初选',
    })

    const updated = await store.addItem({
      symbol: '000001',
      group: 'A股核心',
      notes: '平安银行分红率良好',
    })

    expect(updated.notes).toBe('平安银行分红率良好')
    expect(updated.addedAt).toBe(original.addedAt)
  })

  it('removes items by symbol or symbol with group', async () => {
    await store.addItem({ symbol: 'DOGEUSDT', group: '观察池' })
    await store.addItem({ symbol: 'DOGEUSDT', group: '加密货币' })

    // Remove only from 观察池
    const removedOne = await store.removeItem('DOGEUSDT', '观察池')
    expect(removedOne).toBe(true)

    const remaining = await store.listItems()
    const dogeInCrypto = remaining.find(it => it.symbol === 'DOGEUSDT' && it.group === '加密货币')
    expect(dogeInCrypto).toBeDefined()

    // Remove from all groups
    const removedAll = await store.removeItem('DOGEUSDT')
    expect(removedAll).toBe(true)

    const finalItems = await store.listItems()
    expect(finalItems.find(it => it.symbol === 'DOGEUSDT')).toBeUndefined()
  })
})
