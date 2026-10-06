import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MarketData } from '../src/index.js'
import type { Candle, InstrumentInfo, MarketDataProvider, OhlcvQuery } from '../src/index.js'

/**
 * A canned provider that records every query it serves, so tests can assert
 * both which provider the hub resolved and what it forwarded.
 */
interface RecordingProvider extends MarketDataProvider {
  readonly ohlcvCalls: OhlcvQuery[]
  listSymbolsCalls: number
}

function makeProvider(id: string): RecordingProvider {
  const ohlcvCalls: OhlcvQuery[] = []
  const provider: RecordingProvider = {
    id,
    description: `test provider '${id}'`,
    ohlcvCalls,
    listSymbolsCalls: 0,
    async listSymbols(): Promise<InstrumentInfo[]> {
      provider.listSymbolsCalls += 1
      return [{ symbol: `${id.toUpperCase()}-SYM`, assetClass: 'test' }]
    },
    async getOhlcv(query: OhlcvQuery): Promise<Candle[]> {
      ohlcvCalls.push(query)
      return [{ time: '2024-01-01T00:00:00Z', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }]
    },
  }
  return provider
}

/** Fresh hub per test: MarketData registers itself on the context by name. */
function makeHub(config?: MarketData.Config): MarketData {
  return new MarketData(new Context(), config)
}

describe('MarketData registry', () => {
  it('mounts a provider and exposes it via list()', () => {
    const hub = makeHub()
    hub.register(makeProvider('csv'))
    expect(hub.list()).toEqual(['csv'])
  })

  it('rejects a duplicate id', () => {
    const hub = makeHub()
    hub.register(makeProvider('csv'))
    expect(() => hub.register(makeProvider('csv'))).toThrowError(
      "market-data provider 'csv' is already registered",
    )
  })

  it('unmounts via the returned disposer', () => {
    const hub = makeHub()
    const dispose = hub.register(makeProvider('csv'))
    dispose()
    expect(hub.list()).toEqual([])
  })

  it('disposer is idempotent', () => {
    const hub = makeHub()
    const dispose = hub.register(makeProvider('csv'))
    dispose()
    dispose()
    expect(hub.list()).toEqual([])
  })

  it('a stale disposer does not unmount a re-registered provider of the same id', () => {
    const hub = makeHub()
    const staleDispose = hub.register(makeProvider('csv'))
    staleDispose()
    const replacement = makeProvider('csv')
    hub.register(replacement)
    staleDispose()
    expect(hub.list()).toEqual(['csv'])
    expect(hub.provider('csv')).toBe(replacement)
  })

  it('list() preserves registration order across unmounts', () => {
    const hub = makeHub()
    hub.register(makeProvider('a'))
    const disposeB = hub.register(makeProvider('b'))
    hub.register(makeProvider('c'))
    expect(hub.list()).toEqual(['a', 'b', 'c'])
    disposeB()
    expect(hub.list()).toEqual(['a', 'c'])
  })
})

describe('MarketData.provider resolution', () => {
  it('resolves by id', () => {
    const hub = makeHub()
    const csv = makeProvider('csv')
    hub.register(csv)
    hub.register(makeProvider('ccxt'))
    expect(hub.provider('csv')).toBe(csv)
  })

  it('unknown id throws, naming the mounted ids', () => {
    const hub = makeHub()
    hub.register(makeProvider('csv'))
    hub.register(makeProvider('ccxt'))
    expect(() => hub.provider('nope')).toThrowError(
      "unknown market-data provider 'nope' (mounted: csv, ccxt)",
    )
  })

  it("unknown id with nothing mounted reports 'none'", () => {
    const hub = makeHub()
    expect(() => hub.provider('nope')).toThrowError(
      "unknown market-data provider 'nope' (mounted: none)",
    )
  })

  it('no id resolves the sole mounted provider', () => {
    const hub = makeHub()
    const only = makeProvider('csv')
    hub.register(only)
    expect(hub.provider()).toBe(only)
  })

  it('no id with nothing mounted throws', () => {
    const hub = makeHub()
    expect(() => hub.provider()).toThrowError('no market-data provider is mounted')
  })

  it('no id with several providers and no default throws, naming them', () => {
    const hub = makeHub()
    hub.register(makeProvider('csv'))
    hub.register(makeProvider('ccxt'))
    expect(() => hub.provider()).toThrowError(
      'several providers are mounted (csv, ccxt); pass an id or configure defaultProvider',
    )
  })

  it('defaultProvider config selects among several providers', () => {
    const hub = makeHub({ defaultProvider: 'ccxt' })
    hub.register(makeProvider('csv'))
    const ccxt = makeProvider('ccxt')
    hub.register(ccxt)
    expect(hub.provider()).toBe(ccxt)
  })

  it('a configured default that is not mounted throws as an unknown id', () => {
    const hub = makeHub({ defaultProvider: 'ccxt' })
    hub.register(makeProvider('csv'))
    expect(() => hub.provider()).toThrowError(
      "unknown market-data provider 'ccxt' (mounted: csv)",
    )
  })

  it('an explicit id overrides the configured default', () => {
    const hub = makeHub({ defaultProvider: 'ccxt' })
    const csv = makeProvider('csv')
    hub.register(csv)
    hub.register(makeProvider('ccxt'))
    expect(hub.provider('csv')).toBe(csv)
  })
})

describe('MarketData query routing', () => {
  const query: OhlcvQuery = {
    symbol: 'BTC/USDT',
    timeframe: '1h',
    start: '2024-01-01T00:00:00Z',
    end: '2024-01-02T00:00:00Z',
    limit: 24,
  }

  it('getOhlcv forwards the query to the default provider and returns its candles', async () => {
    const hub = makeHub()
    const only = makeProvider('csv')
    hub.register(only)
    const candles = await hub.getOhlcv(query)
    expect(only.ohlcvCalls).toEqual([query])
    expect(candles).toEqual([
      { time: '2024-01-01T00:00:00Z', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
    ])
  })

  it('getOhlcv routes to the named provider', async () => {
    const hub = makeHub()
    const csv = makeProvider('csv')
    const ccxt = makeProvider('ccxt')
    hub.register(csv)
    hub.register(ccxt)
    await hub.getOhlcv(query, 'ccxt')
    expect(ccxt.ohlcvCalls).toEqual([query])
    expect(csv.ohlcvCalls).toEqual([])
  })

  it('getOhlcv surfaces a resolution failure synchronously, not as a rejection', () => {
    // Resolution errors are wiring errors, not IO errors: the hub fails in
    // the call frame, before a promise exists. `.catch()` alone won't see it.
    const hub = makeHub()
    expect(() => hub.getOhlcv(query)).toThrowError('no market-data provider is mounted')
  })

  it('listSymbols forwards to the default provider', async () => {
    const hub = makeHub()
    const only = makeProvider('csv')
    hub.register(only)
    const symbols = await hub.listSymbols()
    expect(only.listSymbolsCalls).toBe(1)
    expect(symbols).toEqual([{ symbol: 'CSV-SYM', assetClass: 'test' }])
  })

  it('listSymbols routes to the named provider', async () => {
    const hub = makeHub()
    const csv = makeProvider('csv')
    const ccxt = makeProvider('ccxt')
    hub.register(csv)
    hub.register(ccxt)
    await hub.listSymbols('ccxt')
    expect(ccxt.listSymbolsCalls).toBe(1)
    expect(csv.listSymbolsCalls).toBe(0)
  })

  it('listSymbols surfaces a resolution failure synchronously, not as a rejection', () => {
    const hub = makeHub()
    expect(() => hub.listSymbols('nope')).toThrowError(
      "unknown market-data provider 'nope' (mounted: none)",
    )
  })

  it('resolveProvider routes by matchesSymbol across multiple mounted providers', async () => {
    const hub = makeHub({ defaultProvider: 'binance' })
    const binance = {
      ...makeProvider('binance'),
      matchesSymbol: (s: string) => /USDT$|BTC$|ETH$/i.test(s),
    }
    const cn = {
      ...makeProvider('cn'),
      matchesSymbol: (s: string) => /^\d{6}$|^sh\d{6}$|^sz\d{6}$|^bj\d{6}$/i.test(s),
      async getMoneyFlow(symbol: string) {
        return { symbol, netInflow: 1000000, summary: '主力净买入' }
      },
      async getOrderbook(symbol: string) {
        return {
          symbol,
          bids: [{ price: 100, volume: 10 }],
          asks: [{ price: 101, volume: 12 }],
          timestamp: 1234567890,
        }
      },
      async getFundamentals(symbol: string) {
        return {
          symbol,
          peTtm: 25.5,
          marketCap: 2000000000000,
        }
      },
    }

    hub.register(binance)
    hub.register(cn)

    // A-share 600519 routes to cn provider automatically
    expect(hub.resolveProvider('600519').id).toBe('cn')
    // Crypto BTCUSDT routes to binance provider
    expect(hub.resolveProvider('BTCUSDT').id).toBe('binance')
    // Unknown falls back to defaultProvider
    expect(hub.resolveProvider('UNKNOWN').id).toBe('binance')

    // getMoneyFlow dispatches to provider implementing it
    const mf = await hub.getMoneyFlow('600519')
    expect(mf?.netInflow).toBe(1000000)

    // Provider without getMoneyFlow returns null
    const mfCrypto = await hub.getMoneyFlow('BTCUSDT')
    expect(mfCrypto).toBeNull()

    // getOrderbook dispatches to provider implementing it
    const ob = await hub.getOrderbook('600519')
    expect(ob?.bids[0]?.price).toBe(100)
    expect(ob?.asks[0]?.price).toBe(101)

    const obCrypto = await hub.getOrderbook('BTCUSDT')
    expect(obCrypto).toBeNull()

    // getFundamentals dispatches to provider implementing it
    const fund = await hub.getFundamentals('600519')
    expect(fund?.peTtm).toBe(25.5)

    const fundCrypto = await hub.getFundamentals('BTCUSDT')
    expect(fundCrypto).toBeNull()
  })
})
