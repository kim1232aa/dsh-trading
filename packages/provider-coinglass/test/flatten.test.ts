import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { flattenWalls } from '../src/client.js'
import { renderLargeOrders } from '../src/format.js'
import type { LargeOrdersSnapshot } from '../src/types.js'

const here = dirname(fileURLToPath(import.meta.url))

describe('flattenWalls + render', () => {
  it('flattens fixture walls and renders Chinese summary', () => {
    const groups = JSON.parse(readFileSync(join(here, 'fixtures/walls-sample.json'), 'utf8'))
    const walls = flattenWalls(groups)
    expect(walls.length).toBeGreaterThan(5)
    expect(walls.some(w => w.side === 'buy')).toBe(true)
    expect(walls.some(w => w.side === 'sell')).toBe(true)
    walls.sort((a, b) => b.currentUsd - a.currentUsd)
    const snap: LargeOrdersSnapshot = {
      cgSymbol: 'Binance_BTCUSDT',
      pair: 'BTCUSDT',
      startTime: 1,
      endTime: 2,
      walls: walls.slice(0, 10),
      statistics: [],
      orderCount: walls.length,
    }
    const text = renderLargeOrders(snap, 6)
    expect(text).toContain('大额挂单 BTCUSDT')
    expect(text).toMatch(/买墙|卖墙/)
  })
})

describe('minUsd wall filter via getLargeOrders', () => {
  it('drops walls below minUsd; orderCount is post-filter pre-slice length', async () => {
    const groups = JSON.parse(readFileSync(join(here, 'fixtures/walls-sample.json'), 'utf8'))
    const { CoinglassCapi } = await import('../src/client.js')
    class Stub extends CoinglassCapi {
      async largeTakerOrder(): Promise<unknown> {
        return groups
      }
      async largeTakerOrderStatistics(): Promise<unknown> {
        return []
      }
    }
    const client = new Stub()
    const all = flattenWalls(groups)
    const minUsd = 3_000_000
    const expectedKept = all.filter(w => w.currentUsd >= minUsd).length
    expect(expectedKept).toBeGreaterThan(0)
    expect(expectedKept).toBeLessThan(all.length)

    const snap = await client.getLargeOrders('BTCUSDT', { minUsd, top: 5, hours: 1 })
    expect(snap.walls.every(w => w.currentUsd >= minUsd)).toBe(true)
    expect(snap.walls.length).toBe(Math.min(5, expectedKept))
    expect(snap.orderCount).toBe(expectedKept)

    const unfiltered = await client.getLargeOrders('BTCUSDT', { top: 500, hours: 1, status: 'all' })
    expect(unfiltered.orderCount).toBe(all.length)
  })

  it('filters active orders (state===1) by default and supports distance and balanced options', async () => {
    const { CoinglassCapi } = await import('../src/client.js')
    const mockGroups = [
      {
        instrument: { exName: 'Binance' },
        list: [
          {
            price: 2400,
            currentUsd: 5_000_000,
            startUsd: 5_000_000,
            currentAmount: 2000,
            startAmount: 2000,
            volUsd: 0,
            state: 1, // active buy
            side: 2,  // buy
            startTime: 100,
            currentTime: 200,
          },
          {
            price: 2410,
            currentUsd: 12_000_000,
            startUsd: 12_000_000,
            currentAmount: 5000,
            startAmount: 5000,
            volUsd: 0,
            state: 2, // revoked/dead buy from earlier
            side: 2,  // buy
            startTime: 50,
            currentTime: 150,
          },
          {
            price: 2450,
            currentUsd: 6_000_000,
            startUsd: 6_000_000,
            currentAmount: 2400,
            startAmount: 2400,
            volUsd: 0,
            state: 1, // active sell
            side: 1,  // sell
            startTime: 110,
            currentTime: 210,
          },
          {
            price: 9000, // extreme distant sell
            currentUsd: 20_000_000,
            startUsd: 20_000_000,
            currentAmount: 2200,
            startAmount: 2200,
            volUsd: 0,
            state: 1, // active but > 35% distance
            side: 1,  // sell
            startTime: 10,
            currentTime: 210,
          },
        ],
      },
    ]

    class MockClient extends CoinglassCapi {
      async largeTakerOrder(): Promise<unknown> {
        return mockGroups
      }
      async largeTakerOrderStatistics(): Promise<unknown> {
        return []
      }
    }
    const client = new MockClient()

    // 1. By default, status is 'active', so the dead order (state: 2 at 2410) is excluded
    const activeSnap = await client.getLargeOrders('ETHUSDT', {
      currentPrice: 2420,
      maxDistancePct: 0.35,
      balanced: true,
      top: 10,
    })

    expect(activeSnap.walls.some(w => w.price === 2410)).toBe(false) // state 2 excluded
    expect(activeSnap.walls.some(w => w.price === 9000)).toBe(false) // distant order excluded
    expect(activeSnap.walls.some(w => w.price === 2400)).toBe(true)  // active buy near price kept
    expect(activeSnap.walls.some(w => w.price === 2450)).toBe(true)  // active sell near price kept
    expect(activeSnap.updatedAt).toBeGreaterThan(0)

    // 2. Status 'all' includes state 2
    const allSnap = await client.getLargeOrders('ETHUSDT', {
      status: 'all',
      maxDistancePct: 10, // allow distant
      balanced: false,
    })
    expect(allSnap.walls.some(w => w.price === 2410)).toBe(true)
    expect(allSnap.walls.some(w => w.price === 9000)).toBe(true)
  })
})
