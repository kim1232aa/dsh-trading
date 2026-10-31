import { describe, expect, it } from 'vitest'
import { CoinglassCapi, buildMultiExchangeCgSymbols, isRateLimitError } from '../src/client.js'

const wallsFor = (exName: string, price: number) => [
  { instrument: { exName, contractType: 'PERPETUAL', type: 1 }, list: [{ id: `${exName}-${price}`, side: 2, price, currentUsd: 2_000_000, state: 1 }] },
]

/** Counts capi hits per symbol; behaviour per call is scripted by `reply`. */
class Scripted extends CoinglassCapi {
  calls: string[] = []
  stats = 0
  reply: (cgSymbol: string, n: number) => Promise<unknown> = async sym => wallsFor(sym.split('_')[0] ?? 'X', 80_000)
  constructor(private readonly box = { t: 1_000_000 }) {
    super({ now: () => box.t })
  }
  get clock(): number {
    return this.box.t
  }
  set clock(v: number) {
    this.box.t = v
  }
  override async largeTakerOrder(cgSymbol: string): Promise<unknown> {
    this.calls.push(cgSymbol)
    return this.reply(cgSymbol, this.calls.filter(c => c === cgSymbol).length)
  }
  override async largeTakerOrderStatistics(): Promise<unknown> {
    this.stats += 1
    return []
  }
  hits(sym: string): number {
    return this.calls.filter(c => c === sym).length
  }
}

const ALL = buildMultiExchangeCgSymbols('BTCUSDT')
const too = () => Promise.reject(new Error('coinglass HTTP 429: {"code":429,"message":"Too Many Requests"}'))

describe('CoinGlass pull cache / dedupe / 429 cooldown', () => {
  it('recognises the capi 429 error text', () => {
    expect(isRateLimitError(new Error('coinglass HTTP 429: {"code":429}'))).toBe(true)
    expect(isRateLimitError(new Error('coinglass HTTP 500: x'))).toBe(false)
    expect(isRateLimitError('429')).toBe(false)
  })

  it('serves repeated polls from cache: primary every 15 s, secondary venues every 60 s', async () => {
    const c = new Scripted()
    await c.getLargeOrders('BTCUSDT')
    expect(c.calls).toEqual(ALL)
    await c.getLargeOrders('BTCUSDT', { minUsd: 5, currentPrice: 80_000 })
    expect(c.calls).toHaveLength(ALL.length) // different filters, same raw pull

    c.clock += 20_000
    await c.getLargeOrders('BTCUSDT')
    expect(c.hits('Binance_BTCUSDT')).toBe(2)
    expect(c.hits('Bybit_BTCUSDT')).toBe(1)

    c.clock += 45_000
    await c.getLargeOrders('BTCUSDT')
    expect(c.hits('Binance_BTCUSDT')).toBe(3)
    expect(c.hits('Bybit_BTCUSDT')).toBe(2)
  })

  it('keys the cache by hours window', async () => {
    const c = new Scripted()
    await c.getLargeOrders('BTCUSDT', { hours: 72 })
    await c.getLargeOrders('BTCUSDT', { hours: 168 })
    expect(c.hits('Binance_BTCUSDT')).toBe(2)
  })

  it('shares one in-flight request between concurrent callers', async () => {
    const c = new Scripted()
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    c.reply = async sym => { await gate; return wallsFor('Binance', sym.length) }
    const a = c.getLargeOrders('BTCUSDT')
    const b = c.getLargeOrders('BTCUSDT')
    release()
    await Promise.all([a, b])
    expect(c.hits('Binance_BTCUSDT')).toBe(1)
  })

  it('an aborted caller does not cancel the shared pull for the others', async () => {
    const c = new Scripted()
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    c.reply = async () => { await gate; return wallsFor('Binance', 80_000) }
    const ctl = new AbortController()
    const a = c.getLargeOrders('BTCUSDT', { signal: ctl.signal })
    const b = c.getLargeOrders('BTCUSDT')
    ctl.abort()
    await expect(a).rejects.toBeDefined()
    release()
    const snap = await b
    expect(snap.walls.length).toBeGreaterThan(0)
    expect(c.hits('Binance_BTCUSDT')).toBe(1)
  })

  it('on 429 serves the last good pull marked stale, then backs off without calling capi', async () => {
    const c = new Scripted()
    const first = await c.getLargeOrders('BTCUSDT')
    expect(first.stale).toBeUndefined()
    expect(first.updatedAt).toBe(1_000_000)

    c.clock += 20_000
    c.reply = too
    const second = await c.getLargeOrders('BTCUSDT')
    expect(second.stale).toBe(true)
    expect(second.updatedAt).toBe(1_000_000)
    expect(second.walls.map(w => w.price)).toEqual(first.walls.map(w => w.price))
    expect(c.rateLimitRemainingMs()).toBe(15_000)

    const before = c.calls.length
    c.clock += 5_000
    const third = await c.getLargeOrders('BTCUSDT')
    expect(c.calls.length).toBe(before) // cooldown: no request at all
    expect(third.stale).toBe(true)

    c.clock += 11_000 // cooldown over, still refused → doubled cooldown
    await c.getLargeOrders('BTCUSDT')
    expect(c.rateLimitRemainingMs()).toBe(30_000)

    c.clock += 31_000
    c.reply = async () => wallsFor('Binance', 81_000)
    const healed = await c.getLargeOrders('BTCUSDT')
    expect(healed.stale).toBeUndefined()
    expect(healed.walls.map(w => w.price)).toContain(81_000)
    expect(c.rateLimitRemainingMs()).toBe(0)
  })

  it('without any good pull a 429 still rejects, and the cooldown error names the wait', async () => {
    const c = new Scripted()
    c.reply = too
    await expect(c.getLargeOrders('BTCUSDT')).rejects.toThrow(/HTTP 429/)
    await expect(c.getLargeOrders('BTCUSDT')).rejects.toThrow(/cooldown: retry in 15s/)
  })

  it('drops last-good data older than 10 minutes', async () => {
    const c = new Scripted()
    await c.getLargeOrders('BTCUSDT')
    c.clock += 11 * 60_000
    c.reply = too
    await expect(c.getLargeOrders('BTCUSDT')).rejects.toThrow(/HTTP 429/)
  })

  it('counts failed secondary venues without failing the snapshot', async () => {
    const c = new Scripted()
    c.reply = async sym => {
      if (sym === 'Hyperliquid_BTC-USD' || sym === 'Kraken_SPOT_XBT/USD') throw new Error('coinglass HTTP 500: boom')
      return wallsFor(sym.split('_')[0] ?? 'X', 80_000)
    }
    const snap = await c.getLargeOrders('BTCUSDT')
    expect(snap.failedSources).toBe(2)
    expect(snap.stale).toBeUndefined()
  })

  it('statistics:false skips the statistics request; default still pulls it', async () => {
    const c = new Scripted()
    await c.getLargeOrders('BTCUSDT', { statistics: false })
    expect(c.stats).toBe(0)
    await c.getLargeOrders('BTCUSDT')
    expect(c.stats).toBe(1)
  })
})
