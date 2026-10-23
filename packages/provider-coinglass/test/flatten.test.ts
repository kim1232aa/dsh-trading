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
    expect(text).toContain('Binance合约')
    expect(text).toContain('OKX合约')
  })

  it('normalizes market to spot | perp and preserves instrumentId across all 5 live BTC instrument types', () => {
    const liveGroups = [
      {
        instrument: { exName: 'Binance', baseAsset: 'BTC', contractType: 'PERPETUAL', type: 1 },
        list: [{ id: 1, side: 2, price: 81460, currentUsd: 1_500_000, state: 1 }],
      },
      {
        instrument: { exName: 'OKX', baseAsset: 'BTC', contractType: '', type: 1, instrumentId: 'BTC-USDT-SWAP' },
        list: [{ id: 2, side: 2, price: 81379, currentUsd: 1_200_000, state: 1 }],
      },
      {
        instrument: { exName: 'OKX', baseAsset: 'BTC', type: 10, instrumentId: 'BTC-USDT' },
        list: [{ id: 3, side: 2, price: 80500, currentUsd: 2_100_000, state: 1 }],
      },
      {
        instrument: { exName: 'Binance', baseAsset: 'BTC', type: 10, instrumentId: 'BTCUSDT' },
        list: [{ id: 4, side: 1, price: 81853, currentUsd: 1_800_000, state: 1 }],
      },
      {
        instrument: { exName: 'Coinbase', baseAsset: 'BTC', type: 10, instrumentId: 'BTC-USD' },
        list: [{ id: 5, side: 1, price: 81915, currentUsd: 1_600_000, state: 1 }],
      },
    ]

    const walls = flattenWalls(liveGroups)
    expect(walls).toHaveLength(5)
    expect(walls[0]).toMatchObject({ exchange: 'Binance', market: 'perp' })
    expect(walls[0]!.instrumentId).toBeUndefined()
    expect(walls[1]).toMatchObject({ exchange: 'OKX', market: 'perp', instrumentId: 'BTC-USDT-SWAP' })
    expect(walls[2]).toMatchObject({ exchange: 'OKX', market: 'spot', instrumentId: 'BTC-USDT' })
    expect(walls[3]).toMatchObject({ exchange: 'Binance', market: 'spot', instrumentId: 'BTCUSDT' })
    expect(walls[4]).toMatchObject({ exchange: 'Coinbase', market: 'spot', instrumentId: 'BTC-USD' })

    const snap: LargeOrdersSnapshot = {
      cgSymbol: 'Binance_BTCUSDT',
      pair: 'BTCUSDT',
      startTime: 1,
      endTime: 2,
      walls,
      statistics: [],
      orderCount: walls.length,
    }
    const rendered = renderLargeOrders(snap)
    expect(rendered).toContain('Binance合约')
    expect(rendered).toContain('Binance现货')
    expect(rendered).toContain('OKX合约')
    expect(rendered).toContain('OKX现货')
    expect(rendered).toContain('Coinbase现货')
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

  it('filters by marketType and orders near-price walls closest to currentPrice first', async () => {
    const { CoinglassCapi } = await import('../src/client.js')
    const mockGroups = [
      {
        instrument: { exName: 'Binance', contractType: 'PERPETUAL', type: 1 },
        list: [
          { id: 'b-70k', side: 2, price: 70000, currentUsd: 25_000_000, state: 1 },
          { id: 'b-80450', side: 2, price: 80450, currentUsd: 1_200_000, state: 1 },
          { id: 'b-81460', side: 2, price: 81460, currentUsd: 1_500_000, state: 1 },
          { id: 's-82070', side: 1, price: 82070, currentUsd: 1_400_000, state: 1 },
          { id: 's-90k', side: 1, price: 90000, currentUsd: 30_000_000, state: 1 },
        ],
      },
      {
        instrument: { exName: 'Binance', type: 10, instrumentId: 'BTCUSDT' },
        list: [
          { id: 'b-80500', side: 2, price: 80500, currentUsd: 1_100_000, state: 1 },
          { id: 'b-81379', side: 2, price: 81379, currentUsd: 1_300_000, state: 1 },
          { id: 's-81853', side: 1, price: 81853, currentUsd: 1_100_000, state: 1 },
          { id: 's-81915', side: 1, price: 81915, currentUsd: 1_250_000, state: 1 },
        ],
      },
    ]

    class OrderBookMock extends CoinglassCapi {
      async largeTakerOrder(): Promise<unknown> {
        return mockGroups
      }
      async largeTakerOrderStatistics(): Promise<unknown> {
        return []
      }
    }
    const client = new OrderBookMock()

    // With currentPrice=81600 and top=4 (2 buys + 2 sells):
    // Nearest buys (81460, 81379) and nearest sells (81853, 81915) must be picked,
    // NOT displaced by the far-away $25M@70k and $30M@90k walls.
    const nearSnap = await client.getLargeOrders('BTCUSDT', {
      currentPrice: 81600,
      top: 4,
      balanced: true,
    })
    expect(nearSnap.walls.map(w => w.price)).toEqual([81460, 81379, 81853, 81915])

    // Without currentPrice and balanced=true: picks top half by currentUsd, then sorts buys desc and sells asc by price
    const usdSnap = await client.getLargeOrders('BTCUSDT', {
      top: 4,
      balanced: true,
    })
    expect(usdSnap.walls.map(w => w.price)).toEqual([81460, 70000, 82070, 90000])

    // Filter by marketType='spot'
    const spotSnap = await client.getLargeOrders('BTCUSDT', {
      marketType: 'spot',
      currentPrice: 81600,
    })
    expect(spotSnap.walls.every(w => w.market === 'spot')).toBe(true)
    expect(spotSnap.walls.map(w => w.price)).toEqual([81379, 80500, 81853, 81915])

    // Filter by marketType='perp'
    const perpSnap = await client.getLargeOrders('BTCUSDT', {
      marketType: 'perp',
      currentPrice: 81600,
    })
    expect(perpSnap.walls.every(w => w.market === 'perp')).toBe(true)
    expect(perpSnap.walls.map(w => w.price)).toEqual([81460, 80450, 70000, 82070, 90000])
  })
})
