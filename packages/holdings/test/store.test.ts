import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HoldingsStore } from '../src/store.js'

describe('HoldingsStore Two-Zone Persistence', () => {
  let testDir: string
  let store: HoldingsStore

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dsh-holdings-test-'))
    store = new HoldingsStore({ baseDir: testDir })
  })

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('stages a trade and lists it in staging zone', async () => {
    const trade = await store.stageTrade({
      symbol: 'ETHUSDT',
      side: 'buy',
      quantity: 5,
      price: 2600,
      currency: 'USDT',
      notes: 'Test staging',
    })

    expect(trade.id).toBeDefined()
    expect(trade.status).toBe('staged')

    const stagedList = await store.listStagedTrades()
    expect(stagedList.length).toBe(1)
    expect(stagedList[0]?.id).toBe(trade.id)
    expect(stagedList[0]?.symbol).toBe('ETHUSDT')

    // Initial positions must still be empty because trade is uncommitted
    const positions = await store.getPositions()
    expect(positions.length).toBe(0)
  })

  it('commits a staged trade into permanent holdings ledger', async () => {
    const stagedTrade = await store.stageTrade({
      symbol: 'ETHUSDT',
      side: 'buy',
      quantity: 10,
      price: 2500,
      currency: 'USDT',
      fee: 5,
    })

    const { trade, position, realizedPnlDelta } = await store.commitTrade(stagedTrade.id)

    expect(trade.status).toBe('committed')
    expect(trade.committedAt).toBeDefined()
    expect(position.symbol).toBe('ETHUSDT')
    expect(position.quantity).toBe(10)
    expect(position.averageCost).toBe(2500.5) // (10*2500 + 5) / 10 = 2500.5
    expect(realizedPnlDelta).toBe(0)

    // Staging zone should now be empty
    const stagedList = await store.listStagedTrades()
    expect(stagedList.length).toBe(0)

    // Positions should now contain ETHUSDT
    const positions = await store.getPositions()
    expect(positions.length).toBe(1)
    expect(positions[0]?.symbol).toBe('ETHUSDT')
    expect(positions[0]?.quantity).toBe(10)
  })

  it('discards a candidate trade without affecting positions', async () => {
    const staged = await store.stageTrade({
      symbol: 'SOLUSDT',
      side: 'buy',
      quantity: 20,
      price: 150,
      currency: 'USDT',
    })

    const discarded = await store.discardTrade(staged.id)
    expect(discarded.status).toBe('discarded')

    const stagedList = await store.listStagedTrades()
    expect(stagedList.length).toBe(0)

    const positions = await store.getPositions()
    expect(positions.length).toBe(0)
  })

  it('updates market prices and reflects in portfolio summary', async () => {
    const t = await store.stageTrade({
      symbol: '600519',
      side: 'buy',
      quantity: 100,
      price: 1500,
      currency: 'CNY',
    })
    await store.commitTrade(t.id)

    await store.updateMarketPrices({
      '600519': 1600,
    })

    const summary = await store.getPortfolioSummary()
    expect(summary.positions.length).toBe(1)
    const pos = summary.positions[0]!
    expect(pos.currentPrice).toBe(1600)
    expect(pos.marketValue).toBe(160000)
    expect(pos.unrealizedPnl).toBe(10000)
    expect(summary.totalMarketValue.CNY).toBe(160000)
    expect(summary.totalUnrealizedPnl.CNY).toBe(10000)
  })
})
