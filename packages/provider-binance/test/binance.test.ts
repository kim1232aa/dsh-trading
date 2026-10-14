import { describe, expect, it } from 'vitest'
import {
  closestSymbol,
  crowdVsWhaleOf,
  normalizeSymbol,
  postureOf,
  quadrantNote,
  basisPct,
  positionReadings,
  quadrantOf,
  sampleAtOrBefore,
} from '../src/index.js'

describe('Binance Provider Helpers', () => {
  it('normalizes various symbol representations', () => {
    expect(normalizeSymbol('ETHUSDT')).toBe('ETHUSDT')
    expect(normalizeSymbol('ethusdt')).toBe('ETHUSDT')
    expect(normalizeSymbol('ETH/USDT')).toBe('ETHUSDT')
    expect(normalizeSymbol('eth_usdt')).toBe('ETHUSDT')
    expect(normalizeSymbol('ETH-USDT')).toBe('ETHUSDT')
    expect(normalizeSymbol('ETH')).toBe('ETHUSDT')
    expect(normalizeSymbol('btc')).toBe('BTCUSDT')
    expect(normalizeSymbol('ETHUDST')).toBe('ETHUSDT')
    expect(normalizeSymbol('ETHUSTD')).toBe('ETHUSDT')
  })

  it('suggests closest symbol on typos', () => {
    const list = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']
    expect(closestSymbol('ETUUSDT', list)).toBe('ETHUSDT')
    expect(closestSymbol('BCUSDT', list)).toBe('BTCUSDT')
    expect(closestSymbol('XYZNOTFOUND', list)).toBeNull()
  })

  it('derives posture correctly from price and OI deltas', () => {
    expect(postureOf(1.5, 2.0, false)).toBe('多头增仓')
    expect(postureOf(-1.5, 2.0, false)).toBe('空头增仓')
    expect(postureOf(1.5, -2.0, false)).toBe('空头回补')
    expect(postureOf(-1.5, -2.0, false)).toBe('多头平仓')
    expect(postureOf(1.5, 2.0, true)).toBe('价涨增仓 (多头增仓为主)')
    expect(postureOf(0.01, 0.01, false)).toBe('持仓持平')

    // Multi-factor taker volume & funding rate evaluation
    expect(postureOf(1.5, 2.0, false, { takerRatio: 1.35 })).toBe('多头主动吃单做多')
    expect(postureOf(1.5, 2.0, false, { takerRatio: 0.82 })).toBe('多头被动推高 (量能背离)')
    expect(postureOf(-1.5, 2.0, false, { takerRatio: 0.75 })).toBe('空头主动砸盘做空')
    expect(postureOf(-1.5, 2.0, false, { takerRatio: 1.25 })).toBe('大户接盘吸筹 (散户追空)')
    expect(postureOf(-2.5, -2.5, false, { takerRatio: 0.6 })).toBe('多头恐慌清算踩踏')
    expect(postureOf(2.5, -2.5, false, { takerRatio: 1.4 })).toBe('空头爆仓轧空止损')
    expect(postureOf(1.5, 2.0, true, { fundingRate: 0.0004 })).toBe('价涨增仓 (多头增仓为主) [多头费率极度拥挤]')
    expect(postureOf(-1.5, 2.0, true, { fundingRate: -0.0003 })).toBe('价跌增仓 (空头增仓为主) [空头负费率过度拥挤]')
  })

  it('derives crowd vs whale sentiment correctly', () => {
    expect(crowdVsWhaleOf(2.0, 1.2)).toBe('散户极度接多(多73%+)，大户未跟偏空 (对手盘风险)')
    expect(crowdVsWhaleOf(0.7, 1.6)).toBe('散户恐慌割肉做空，大户逆势吸筹做多')
    expect(crowdVsWhaleOf(1.6, 1.9)).toBe('大户散户共识做多')
    expect(crowdVsWhaleOf(0.7, 0.9)).toBe('大户散户共识做空')
    expect(crowdVsWhaleOf(1.0, 1.0)).toBeNull()
  })

  it('labels a real 1h price-up / OI-down as 价涨减仓, not the 149-minute dead-zone read', () => {
    // Live ETHUSDT case: oldest 5m sample was ~149m back (price +0.389%, OI -0.209%).
    // |OI| < 0.3% is the 1h dead zone, so that window printed 持仓持平.
    expect(postureOf(0.389, -0.209, true)).toBe('持仓持平')
    // The bar at or before now-60m was price +0.309%, OI -0.383%.
    expect(postureOf(0.309, -0.383, true)).toBe('价涨减仓 (空头回补为主)')
    expect(quadrantOf(0.309, -0.383, true)).toBe('弱反弹 / 轧空')
    expect(quadrantNote('弱反弹 / 轧空')).toBe('空头止损平仓推动，容易衰竭')
    expect(quadrantOf(1.5, 2, true)).toBe('强多头')
    expect(quadrantNote('强多头')).toBe('多头真金白银主动开仓推高，趋势健康')
    expect(quadrantOf(-1.5, 2, true)).toBe('强空头')
    expect(quadrantNote('强空头')).toBe('空头主动大举增仓砸盘，下跌动能足')
    expect(quadrantOf(-1.5, -2, true)).toBe('多头踩踏')
    expect(quadrantNote('多头踩踏')).toBe('多头爆仓或割肉平仓，属于杀多行情')
    expect(quadrantOf(0.389, -0.209, true)).toBeNull()
  })

  it('anchors the 1h sample to 60 minutes, and refuses a series that does not reach that far', () => {
    const start = Date.parse('2026-10-14T06:10:00.000Z')
    const rows = Array.from({ length: 30 }, (_, i) => ({
      timestamp: start + i * 5 * 60_000,
      sumOpenInterest: String(1000 - i),
    }))
    const now = start + 29 * 5 * 60_000 + 3 * 60_000
    const anchor = sampleAtOrBefore(rows, now, 60 * 60_000)
    expect(anchor?.['timestamp']).toBe(start + 17 * 5 * 60_000)
    expect(anchor?.['sumOpenInterest']).toBe('983')
    expect(sampleAtOrBefore(rows.slice(-6), now, 60 * 60_000)).toBeNull()
    expect(sampleAtOrBefore(
      [{ timestamp: now - 80 * 60_000, sumOpenInterest: '1' }],
      now,
      60 * 60_000,
    )).toBeNull()
  })

  it('turns Binance ratio series into descriptive states, not a direction call', () => {
    const rows = positionReadings({
      longShortRatio: 1.42,
      topPositionRatio: 0.81,
      topAccountRatio: 1.2,
      takerBuySellRatio: 1.2,
      fundingRate: 0.0004,
      basisPct: 0.08,
    })
    expect(rows.map(r => r.id)).toEqual([
      'accounts', 'top-positions', 'top-accounts', 'crowd-vs-size', 'whale-split', 'taker', 'funding', 'basis',
    ])
    expect(rows.map(r => r.label)).toEqual([
      '人数偏多 1.42',
      '大户仓偏空 0.81',
      '大户户偏多 1.20',
      '人数多、大户仓空',
      '头部仓位在空',
      '主动买 1.20',
      '多头拥挤',
      '升水 0.080%',
    ])
    expect(rows.find(r => r.id === 'accounts')?.note).toContain('不是仓位')
    expect(rows.find(r => r.id === 'funding')?.tone).toBe('warn')
    expect(positionReadings({}).map(r => r.id)).toEqual([])
    expect(positionReadings({ fundingRate: 0.00005 }).map(r => r.label)).toEqual(['费率中性'])
    expect(basisPct(2502, 2500)).toBeCloseTo(0.08, 2)
    expect(basisPct(2500, 0)).toBeNull()
  })
})
