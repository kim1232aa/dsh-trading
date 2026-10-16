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

    const unfiltered = await client.getLargeOrders('BTCUSDT', { top: 500, hours: 1 })
    expect(unfiltered.orderCount).toBe(all.length)
  })
})
