import { describe, expect, it } from 'vitest'
import { CoinglassCapi, flattenTrades } from '../src/client.js'

// Shape of /api/largeOrder verified live 2026-11-04 against coinglass.com:
// OKX 2296.01 side 2 = 大额买入, 2297.99 side 1 = 大额卖出.
const GROUPS = [
  { instrument: { exName: 'OKX', instrumentId: 'ETH-USDT-SWAP', type: 1 }, list: [
    { id: 'a', side: 2, price: 2296.01, volUsd: 767_000, baseVol: 333.98, turnoverTime: 1_762_186_074_000 },
    { id: 'b', side: 1, price: 2297.99, volUsd: 569_000, baseVol: 247.53, turnoverTime: 1_762_185_711_000 },
    { id: 'b', side: 1, price: 2297.99, volUsd: 569_000, baseVol: 247.53, turnoverTime: 1_762_185_711_000 },
  ] },
  { instrument: { exName: 'Binance', type: 10 }, list: [
    { id: 'c', side: 2, price: 2290, volUsd: 200_000, baseVol: 87.3, turnoverTime: 1_762_185_000_000 },
    { id: 'd', side: 3, price: 2290, volUsd: 900_000, turnoverTime: 1_762_185_000_000 },
    { id: 'e', side: 1, price: 0, volUsd: 900_000, turnoverTime: 1_762_185_000_000 },
  ] },
]

describe('flattenTrades', () => {
  it('maps side 1/2 to sell/buy, tags spot/perp, dedupes and sorts oldest first', () => {
    const t = flattenTrades(GROUPS)
    expect(t.map(x => x.id)).toEqual(['c', 'b', 'a'])
    expect(t[2]).toMatchObject({ exchange: 'OKX', market: 'perp', side: 'buy', price: 2296.01, usd: 767_000, amount: 333.98 })
    expect(t[1]).toMatchObject({ side: 'sell', market: 'perp' })
    expect(t[0]).toMatchObject({ exchange: 'Binance', market: 'spot' })
  })

  it('returns [] for junk', () => {
    expect(flattenTrades(null)).toEqual([])
    expect(flattenTrades({})).toEqual([])
  })
})

class Stub extends CoinglassCapi {
  tradeCalls: string[] = []
  failTrades = false
  override async largeTakerOrder(): Promise<unknown> { return [] }
  override async largeOrder(cgSymbol: string): Promise<unknown> {
    this.tradeCalls.push(cgSymbol)
    if (this.failTrades) throw new Error('coinglass HTTP 500: x')
    return GROUPS
  }
}

describe('getLargeOrders tradesMinUsd', () => {
  it('skips the trades request unless asked', async () => {
    const c = new Stub()
    const snap = await c.getLargeOrders('ETHUSDT', { statistics: false })
    expect(c.tradeCalls).toEqual([])
    expect(snap.trades).toBeUndefined()
  })

  it('pulls the primary route once, filters by size and market, caches within TTL', async () => {
    const c = new Stub()
    const all = await c.getLargeOrders('ETHUSDT', { statistics: false, tradesMinUsd: 500_000 })
    expect(c.tradeCalls).toEqual(['Binance_ETHUSDT'])
    expect(all.trades?.map(t => t.id)).toEqual(['b', 'a'])
    const spot = await c.getLargeOrders('ETHUSDT', { statistics: false, tradesMinUsd: 100_000, marketType: 'spot' })
    expect(spot.trades?.map(t => t.id)).toEqual(['c'])
    expect(c.tradeCalls).toHaveLength(1)
  })

  it('cuts spot and perp trades by their own thresholds', async () => {
    const c = new Stub()
    const snap = await c.getLargeOrders('ETHUSDT', { statistics: false, tradesMinUsd: 600_000, spotTradesMinUsd: 100_000 })
    expect(snap.trades?.map(t => t.id)).toEqual(['c', 'a'])
  })

  it('a failed trades pull never costs the walls', async () => {
    const c = new Stub()
    c.failTrades = true
    const snap = await c.getLargeOrders('ETHUSDT', { statistics: false, tradesMinUsd: 500_000 })
    expect(snap.walls).toEqual([])
    expect(snap.trades).toBeUndefined()
  })
})
