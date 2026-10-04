import { describe, expect, it } from 'vitest'
import {
  CnMarketProvider,
  cnTimeToIso,
  formatRmbAmount,
  isCnSymbol,
  parseCnSymbol,
  toBarOpen,
} from '../src/index.js'

describe('CN Market Symbol Parsing & Routing', () => {
  it('parses Shanghai main board & STAR board symbols', () => {
    const s1 = parseCnSymbol('600519')
    expect(s1).toEqual({
      code: '600519',
      market: 'sh',
      secid: '1.600519',
      sinaSymbol: 'sh600519',
    })

    const s2 = parseCnSymbol('sh688981')
    expect(s2).toEqual({
      code: '688981',
      market: 'sh',
      secid: '1.688981',
      sinaSymbol: 'sh688981',
    })
  })

  it('parses Shenzhen main board & ChiNext board symbols', () => {
    const s1 = parseCnSymbol('000001')
    expect(s1).toEqual({
      code: '000001',
      market: 'sz',
      secid: '0.000001',
      sinaSymbol: 'sz000001',
    })

    const s2 = parseCnSymbol('300750')
    expect(s2).toEqual({
      code: '300750',
      market: 'sz',
      secid: '0.300750',
      sinaSymbol: 'sz300750',
    })
  })

  it('parses Beijing Stock Exchange (BSE) symbols', () => {
    const s1 = parseCnSymbol('920002')
    expect(s1).toEqual({
      code: '920002',
      market: 'bj',
      secid: '0.920002',
      sinaSymbol: 'bj920002',
    })

    const s2 = parseCnSymbol('bj920002')
    expect(s2).toEqual({
      code: '920002',
      market: 'bj',
      secid: '0.920002',
      sinaSymbol: 'bj920002',
    })
  })

  it('identifies valid A-share symbols and rejects others', () => {
    expect(isCnSymbol('600519')).toBe(true)
    expect(isCnSymbol('sh600519')).toBe(true)
    expect(isCnSymbol('002594')).toBe(true)
    expect(isCnSymbol('920002')).toBe(true)
    expect(isCnSymbol('BTCUSDT')).toBe(false)
    expect(isCnSymbol('ETH-USDT')).toBe(false)
    expect(isCnSymbol('AAPL')).toBe(false)
  })
})

describe('Time and Amount Formatting', () => {
  it('converts Beijing local market time (UTC+8) to UTC ISO string', () => {
    const dayIso = cnTimeToIso('2026-09-30')
    const d = new Date(dayIso)
    expect(d.getUTCFullYear()).toBe(2026)
    expect(d.getUTCMonth()).toBe(8) // 0-based month 8 is September
    expect(d.getUTCDate()).toBe(30)
    // 09:30 Beijing time is 01:30 UTC
    expect(d.getUTCHours()).toBe(1)
    expect(d.getUTCMinutes()).toBe(30)

    const minIso = cnTimeToIso('2026-09-30 14:50:00')
    const md = new Date(minIso)
    // 14:50 Beijing time is 06:50 UTC
    expect(md.getUTCHours()).toBe(6)
    expect(md.getUTCMinutes()).toBe(50)
  })

  it('formats RMB amounts with appropriate units', () => {
    expect(formatRmbAmount(533565520)).toBe('+5.34亿')
    expect(formatRmbAmount(-533026464)).toBe('-5.33亿')
    expect(formatRmbAmount(25000000)).toBe('+2500.0万')
    expect(formatRmbAmount(-12000)).toBe('-1.2万')
  })
})

describe('CnMarketProvider Routing', () => {
  const provider = new CnMarketProvider('cn', 'https://push2his.eastmoney.com', 'https://quotes.sina.cn')

  it('matches A-share symbols', () => {
    expect(provider.matchesSymbol('600519')).toBe(true)
    expect(provider.matchesSymbol('000001')).toBe(true)
    expect(provider.matchesSymbol('300750')).toBe(true)
    expect(provider.matchesSymbol('BTCUSDT')).toBe(false)
  })

  it('lists representative symbols', async () => {
    const list = await provider.listSymbols()
    expect(list.length).toBeGreaterThanOrEqual(10)
    expect(list.some(s => s.symbol === '600519')).toBe(true)
  })

  it('shifts close-labelled intraday bars to bar-open and leaves daily alone', () => {
    const c = [{ time: cnTimeToIso('2026-09-30 09:35'), open: 1, high: 1, low: 1, close: 1, volume: 1 }]
    expect(toBarOpen(c, '5m')[0]!.time).toBe('2026-09-30T01:30:00.000Z')
    expect(toBarOpen(c, '1d')[0]!.time).toBe(c[0]!.time)
  })

  it('refuses a timeframe A-shares do not have instead of serving other bars', async () => {
    await expect(provider.getOhlcv({ symbol: '600519', timeframe: '4h' })).rejects.toThrow(/4h/)
  })
})
