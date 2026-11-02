import { describe, expect, it } from 'vitest'
import {
  dropCrossedWalls,
  filterWallsByMarket,
  formatWallAge,
  isSpotWallMarket,
  isWallCrossed,
  isWallSweptAfterSnapshot,
  WALL_CROSS_TOLERANCE,
  wallAgeSeconds,
} from '../src/client/market-client.js'

const wall = (id: string, market?: string) => ({ id, market })

describe('large-wall market filter', () => {
  const walls = [
    wall('perp', 'perp'),
    wall('spot', 'spot'),
    wall('raw10', '10'),
    wall('upper', 'SPOT'),
    wall('missing'),
  ]

  it('treats spot, SPOT and raw type 10 as spot; missing and perp as contracts', () => {
    expect(isSpotWallMarket('spot')).toBe(true)
    expect(isSpotWallMarket('SPOT')).toBe(true)
    expect(isSpotWallMarket('10')).toBe(true)
    expect(isSpotWallMarket('perp')).toBe(false)
    expect(isSpotWallMarket(undefined)).toBe(false)
  })

  it('现货 keeps only spot books, in order', () => {
    expect(filterWallsByMarket(walls, 'spot').map(w => w.id)).toEqual(['spot', 'raw10', 'upper'])
  })

  it('合约 drops spot books and keeps untagged walls', () => {
    expect(filterWallsByMarket(walls, 'perp').map(w => w.id)).toEqual(['perp', 'missing'])
  })

  it('全部 keeps every wall', () => {
    expect(filterWallsByMarket(walls, 'all')).toHaveLength(5)
  })
})

describe('crossed & swept walls (price traded through while venue snapshot is cached)', () => {
  const price = 2268
  const book = [
    { id: 'okx-ask', side: 'sell', price: 2275.35 },
    { id: 'stale-ask', side: 'sell', price: 2260 },
    { id: 'tight-ask', side: 'sell', price: 2267 },
    { id: 'bid', side: 'buy', price: 2250 },
    { id: 'stale-bid', side: 'buy', price: 2280 },
    { id: 'tight-bid', side: 'buy', price: 2269 },
  ]

  it('uses zero default tolerance so any ask strictly below live price or bid strictly above is hidden', () => {
    expect(WALL_CROSS_TOLERANCE).toBe(0)
    expect(isWallCrossed({ side: 'sell', price: 2267.9 }, price)).toBe(true)
    expect(isWallCrossed({ side: 'sell', price: 2268 }, price)).toBe(false)
    expect(isWallCrossed({ side: 'buy', price: 2268.1 }, price)).toBe(true)
    expect(isWallCrossed({ side: 'buy', price: 2268 }, price)).toBe(false)
  })

  it('honours an explicit custom tolerance when passed', () => {
    expect(isWallCrossed({ side: 'sell', price: 2267 }, price, 0.001)).toBe(false)
    expect(isWallCrossed({ side: 'sell', price: 2264 }, price, 0.001)).toBe(true)
  })

  it('without a usable price nothing is treated as crossed', () => {
    for (const p of [undefined, null, 0, -1, Number.NaN]) {
      expect(dropCrossedWalls(book, p)).toHaveLength(book.length)
    }
  })

  it('drops every crossed wall while preserving book order', () => {
    expect(dropCrossedWalls(book, price).map(w => w.id)).toEqual(['okx-ask', 'bid'])
  })

  it('clears the 2275.35 / 2275.46 asks once price trades up to 2276.80 (-0.06% regression)', () => {
    const asks = [{ side: 'sell', price: 2275.35 }, { side: 'sell', price: 2275.46 }]
    expect(dropCrossedWalls(asks, 2262.77)).toHaveLength(2)
    expect(dropCrossedWalls(asks, 2276.8)).toHaveLength(0)
  })

  it('drops a wall swept by a post-snapshot candle wick even after price pulls back', () => {
    const tSnap = Date.parse('2026-11-02T16:10:00.000Z')
    const ask = { id: 'swept-ask', side: 'sell', price: 2275.35, currentTime: tSnap }
    const bid = { id: 'swept-bid', side: 'buy', price: 2270.0, currentTime: tSnap }
    const preOnly = [{ time: '2026-11-02T16:08:00.000Z', high: 2285, low: 2260 }]
    const postSweep = [
      ...preOnly,
      { time: '2026-11-02T16:11:00.000Z', high: 2278.0, low: 2268.0 },
      { time: '2026-11-02T16:12:00.000Z', high: 2274.2, low: 2271.5 },
    ]
    expect(isWallSweptAfterSnapshot(ask, preOnly)).toBe(false)
    expect(isWallSweptAfterSnapshot(ask, postSweep)).toBe(true)
    expect(isWallSweptAfterSnapshot(bid, postSweep)).toBe(true)
    // Live price 2273 is back below 2275.35 and above 2270, yet both swept zombies stay hidden.
    expect(dropCrossedWalls([ask, bid], 2273, { candles: postSweep })).toEqual([])
  })

  it('does not falsely sweep a 43-min-old untouched wall when a fresh snapshotAt confirmed state=1', () => {
    const tOrder = Date.parse('2026-11-02T16:18:24.000Z')
    const tFreshSnap = Date.parse('2026-11-02T17:02:50.000Z')
    const untouchedSpotAsk = { id: 'bitget-spot-ask', side: 'sell', price: 2277.04, currentTime: tOrder }
    const candles = [
      // 25 min ago Binance wicked to 2279 while Bitget spot did not fill 2277.04;
      // CoinGlass just returned state=1 at 17:02:50.
      { time: '2026-11-02T16:35:00.000Z', high: 2279.5, low: 2270.0 },
      { time: '2026-11-02T17:02:00.000Z', high: 2271.2, low: 2268.0 },
    ]
    expect(dropCrossedWalls([untouchedSpotAsk], 2269.99, { candles, snapshotAt: tFreshSnap })).toHaveLength(1)
    // A wick inside the last 45 s window still drops a swept wall immediately.
    const recentSweep = [...candles, { time: '2026-11-02T17:02:30.000Z', high: 2279.0, low: 2272.0 }]
    expect(dropCrossedWalls([untouchedSpotAsk], 2273.0, { candles: recentSweep, snapshotAt: tFreshSnap })).toEqual([])
  })
})

describe('wall resting duration (formatWallAge / wallAgeSeconds)', () => {
  const now = 1_762_100_000_000

  it('returns empty string / null when startTime is missing or non-positive', () => {
    expect(wallAgeSeconds({}, now)).toBeNull()
    expect(formatWallAge({ startTime: 0 }, now)).toBe('')
    expect(formatWallAge({ startTime: -5 }, now, true)).toBe('')
  })

  it('measures active (state=1) partially-filled orders up to now rather than freezing at currentTime', () => {
    const active = { startTime: now - 4 * 3_600_000, currentTime: now - 3_600_000, state: 1 }
    expect(formatWallAge(active, now)).toBe('4小时0分')
    expect(formatWallAge(active, now, true)).toBe('4小时')
    const revoked = { ...active, state: 2 }
    expect(formatWallAge(revoked, now)).toBe('3小时0分')
  })

  it('formats seconds, minutes, hours and days in both full and compact forms, and normalises epoch seconds', () => {
    expect(formatWallAge({ startTime: now - 42_000 }, now, true)).toBe('42秒')
    expect(formatWallAge({ startTime: now - (14 * 60 + 25) * 1000 }, now)).toBe('14分25秒')
    expect(formatWallAge({ startTime: now - (14 * 60 + 25) * 1000 }, now, true)).toBe('14分')
    expect(formatWallAge({ startTime: now - (3 * 3600 + 12 * 60) * 1000 }, now, true)).toBe('3时12分')
    expect(formatWallAge({ startTime: Math.floor((now - 26 * 3_600_000) / 1000) }, now, true)).toBe('1天2时')
  })
})
