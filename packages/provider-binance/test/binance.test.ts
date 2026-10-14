import { afterEach, describe, expect, it, vi } from 'vitest'
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
  isBinanceSymbol,
  okxLiquidations1h,
  okxDerivatives,
  fundingAnnualizedPct,
  fundingLabelOf,
  cvdFromTakerRows,
  cvdNoteOf,
  pctChange,
  BinanceProvider,
} from '../src/index.js'
import { formatUsdtCn } from '@dsh-trading/market-data'

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
    expect(postureOf(1.5, 2.0, false)).toBe('新仓推动')
    expect(postureOf(-1.5, 2.0, false)).toBe('空头增仓')
    expect(postureOf(1.5, -2.0, false)).toBe('空头回补')
    expect(postureOf(-1.5, -2.0, false)).toBe('多头平仓')
    expect(postureOf(1.5, 2.0, true)).toBe('价涨增仓 (新仓推动为主)')
    expect(postureOf(0.01, 0.01, false)).toBe('持仓持平')

    // Multi-factor taker volume & funding rate evaluation
    expect(postureOf(1.5, 2.0, false, { takerRatio: 1.35 })).toBe('多头主动吃单')
    expect(postureOf(1.5, 2.0, false, { takerRatio: 0.82 })).toBe('多头被动推高')
    expect(postureOf(-1.5, 2.0, false, { takerRatio: 0.75 })).toBe('空头主动砸盘')
    expect(postureOf(-1.5, 2.0, false, { takerRatio: 1.25 })).toBe('大户接盘(人数追空)')
    expect(postureOf(-2.5, -2.5, false, { takerRatio: 0.6 })).toBe('多头踩踏')
    expect(postureOf(2.5, -2.5, false, { takerRatio: 1.4 })).toBe('空头爆仓轧空')
    expect(postureOf(1.5, 2.0, true, { fundingRate: 0.0004 })).toBe('价涨增仓 (新仓推动为主) [费率多头拥挤]')
    expect(postureOf(-1.5, 2.0, true, { fundingRate: -0.0003 })).toBe('价跌增仓 (空头增仓为主) [费率空头拥挤]')
  })

  it('derives crowd vs whale sentiment correctly', () => {
    expect(crowdVsWhaleOf(2.0, 1.2)).toBeNull()
    expect(crowdVsWhaleOf(2.85, 1.55)).toBeNull()
    expect(crowdVsWhaleOf(2.85, 0.8)).toBe('人数多头74%·大户仓偏空')
    expect(crowdVsWhaleOf(0.7, 1.6)).toBe('人数偏空·大户仓偏多')
    expect(crowdVsWhaleOf(1.6, 1.9)).toBe('人数与大户仓同向偏多')
    expect(crowdVsWhaleOf(0.7, 0.8)).toBe('人数与大户仓同向偏空')
    expect(crowdVsWhaleOf(0.7, 0.9)).toBeNull()
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
      '人数多·大户仓空',
      '头部仓位在空',
      '主动买 1.20',
      '多头拥挤',
      '升水 0.080%',
    ])
    expect(rows.find(r => r.id === 'accounts')?.note).toContain('非持仓量')
    expect(rows.find(r => r.id === 'funding')?.tone).toBe('warn')
    expect(positionReadings({}).map(r => r.id)).toEqual([])
    expect(positionReadings({ fundingRate: 0.00005 }).map(r => r.label)).toEqual(['中性≈0.01%/8h'])
    expect(positionReadings({ fundingRate: 0.0001 }).map(r => r.label)).toEqual(['中性≈0.01%/8h'])
    expect(positionReadings({ fundingRate: 0.0002 }).map(r => r.label)).toEqual(['偏多'])
    expect(basisPct(2502, 2500)).toBeCloseTo(0.08, 2)
    expect(basisPct(2500, 0)).toBeNull()
  })
})

describe('isBinanceSymbol', () => {
  it('claims quote-suffixed crypto and refuses A-shares / Futu / bare bases', () => {
    expect(isBinanceSymbol('BTCUSDT')).toBe(true)
    expect(isBinanceSymbol('eth/usdt')).toBe(true)
    expect(isBinanceSymbol('ETH')).toBe(false) // bare base: pass provider or type ETHUSDT
    expect(isBinanceSymbol('DEMO-EQ')).toBe(false)
    expect(isBinanceSymbol('600519')).toBe(false)
    expect(isBinanceSymbol('sh600519')).toBe(false)
    expect(isBinanceSymbol('HK.00700')).toBe(false)
    expect(isBinanceSymbol('CC.BTCUSDT')).toBe(false)
  })
})

describe('OKX derivatives live smoke', () => {
  it('returns USDT OI, multi-horizon Δ, funding APR, CVD, liquidations for BTC', async () => {
    const d = await okxDerivatives('BTCUSDT')
    expect(d.source).toBe('OKX')
    expect(d.openInterest).toBeGreaterThan(0)
    expect(d.openInterestValue).toBeGreaterThan(0)
    expect(d.fundingRate).not.toBeNull()
    expect(d.fundingRateAnnualizedPct).not.toBeNull()
    expect(d.fundingLabel).toMatch(/中性|偏多|偏空|拥挤/)
    expect(d.longShortRatioKind).toBe('global_accounts')
    expect(d.longShortRatio === null || d.longShortRatio > 0).toBe(true)
    expect(d.oiChangePct1h === null || Number.isFinite(d.oiChangePct1h)).toBe(true)
    // History must vary (not a flat live-stamp line)
    if (d.history && d.history.length > 5) {
      const tops = d.history.map(h => h.topPositionRatio).filter((v): v is number => v != null)
      expect(new Set(tops.map(v => v.toFixed(4))).size).toBeGreaterThan(1)
      const ls = d.history.map(h => h.longShortRatio).filter((v): v is number => v != null)
      expect(ls.length).toBeGreaterThan(0)
    }
    expect(d.oiChangePct24h === null || Number.isFinite(d.oiChangePct24h)).toBe(true)
    if (d.liquidationSummary) {
      expect(d.liquidationSummary).toContain('爆仓')
      expect(d.liquidationSource).toBe('OKX')
    }
  }, 45_000)
})

describe('formatUsdtCn', () => {
  it('prints 亿/万 and collapses near-zero', () => {
    expect(formatUsdtCn(7_594_311_663)).toBe('75.94亿')
    expect(formatUsdtCn(910_000)).toBe('91.0万')
    expect(formatUsdtCn(0)).toBe('0')
    expect(formatUsdtCn(323)).toBe('323')
  })
})

describe('funding / CVD / pct helpers', () => {
  it('annualizes 8h funding and treats 0.01%/8h as neutral, not bullish', () => {
    expect(fundingAnnualizedPct(0.0001)).toBeCloseTo(10.95, 2)
    expect(fundingAnnualizedPct(null)).toBeNull()
    expect(fundingLabelOf(0.0001)).toBe('中性≈0.01%/8h')
    expect(fundingLabelOf(0)).toBe('中性≈0.01%/8h')
    expect(fundingLabelOf(0.0002)).toBe('偏多')
    expect(fundingLabelOf(0.0004)).toBe('多头拥挤')
    expect(fundingLabelOf(-0.0001)).toBe('偏空')
    expect(fundingLabelOf(-0.0003)).toBe('空头拥挤')
  })

  it('sums taker buy−sell as CVD and describes price divergence', () => {
    const now = 1_000_000
    const rows = [
      { timestamp: now - 10 * 60_000, buyVol: '10', sellVol: '4' },
      { timestamp: now - 20 * 60_000, buyVol: '5', sellVol: '8' },
      { timestamp: now - 90 * 60_000, buyVol: '100', sellVol: '0' }, // outside 1h
    ]
    expect(cvdFromTakerRows(rows, now)).toBeCloseTo(3, 4) // (10-4)+(5-8)
    expect(cvdNoteOf(3, -0.5)).toBe('CVD↑价↓背离')
    expect(cvdNoteOf(-3, 0.5)).toContain('背离')
    expect(pctChange(110, 100)).toBe(10)
    expect(pctChange(null, 100)).toBeNull()
  })
})

describe('Binance derivatives live smoke', () => {
  it('returns USDT OI, Δ1h/4h/24h, funding APR, labeled L/S, CVD, basis', async () => {
    const provider = new BinanceProvider('binance', ['BTCUSDT'], 'https://data-api.binance.vision', 'https://fapi.binance.com')
    const d = await provider.getDerivatives('BTCUSDT')
    expect(['Binance', 'OKX', 'Gate']).toContain(d.source)
    expect(d.openInterestValue).toBeGreaterThan(0)
    expect(d.oiUnit).toBe('base')
    expect(d.fundingRate).not.toBeNull()
    expect(d.fundingRateAnnualizedPct).not.toBeNull()
    expect(d.fundingLabel).toBeTruthy()
    if (d.source === 'Binance') {
      expect(d.longShortRatioKind).toBe('global_accounts')
      expect(d.longShortRatio).toBeGreaterThan(0)
      expect(d.oiChangePct24h).not.toBeNull()
      expect(d.basisPct).not.toBeNull()
    }
    // Δ1h should resolve when hist is long enough
    expect(d.oiChangePct1h === null || Number.isFinite(d.oiChangePct1h)).toBe(true)
  }, 45_000)
})

describe('OKX liquidations unit (ctVal)', () => {
  it('multiplies sz × ctVal × bkPx for USDT notional', async () => {
    vi.stubGlobal('fetch', async (url: URL | Request | string) => {
      const u = String(url)
      if (u.includes('instruments')) {
        return new Response(JSON.stringify({ code: '0', data: [{ ctVal: '0.01' }] }), { status: 200 })
      }
      if (u.includes('liquidation-orders')) {
        const now = Date.now()
        return new Response(JSON.stringify({
          code: '0',
          data: [{ details: [
            { ts: String(now - 60_000), bkPx: '100000', sz: '10', posSide: 'long' },
            { ts: String(now - 60_000), bkPx: '100000', sz: '5', posSide: 'short' },
          ] }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: '404' }), { status: 404 })
    })
    try {
      const liq = await okxLiquidations1h('BTCUSDT')
      // 10 * 0.01 * 100000 = 10000; 5 * 0.01 * 100000 = 5000
      expect(liq.longUsd).toBe(10000)
      expect(liq.shortUsd).toBe(5000)
      expect(liq.summary).toContain('爆仓')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('OKX derivatives history alignment (no live stamp)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('aligns topPos + account ratio by timestamp; does not stamp live onto every bar', async () => {
    const t0 = 1_790_000_000_000
    // 5 bars newest-first, 5m apart — each with a DISTINCT top-trader ratio
    const oihRows = Array.from({ length: 13 }, (_, i) => {
      const ccy = i === 0 ? 102 : 100
      const px = i === 0 ? 2970 : 3000
      return [String(t0 - i * 300_000), String(ccy * 10), String(ccy), String(ccy * px)]
    })
    const topRows = Array.from({ length: 13 }, (_, i) => [
      String(t0 - i * 300_000),
      String(0.90 + i * 0.01), // 0.90, 0.91, … distinct
    ])
    const accRows = Array.from({ length: 13 }, (_, i) => [
      String(t0 - i * 300_000),
      String(1.50 + i * 0.02), // 1.50, 1.52, …
    ])
    // Newest taker has sell=0 (would produce sentinel 99 if stamped live)
    const takerRows = Array.from({ length: 13 }, (_, i) => [
      String(t0 - i * 300_000),
      i === 0 ? '0' : '100',
      i === 0 ? '50' : String(80 + i),
    ])
    const bodies: Record<string, unknown> = {
      'open-interest-history': oihRows,
      'open-interest': [{ oi: '1020', oiCcy: '102', oiUsd: '302940', ts: String(t0) }],
      'funding-rate': [{ fundingRate: '0.0001', nextFundingTime: String(t0 + 8 * 3600_000) }],
      'long-short-position-ratio-contract-top-trader': topRows,
      'long-short-account-ratio': accRows,
      'taker-volume-contract': takerRows,
      'mark-price': [{ markPx: '2970' }],
      'index-tickers': [{ idxPx: '2968' }],
    }
    vi.stubGlobal('fetch', async (url: URL | Request | string) => {
      const u = String(url)
      // Longer keys first so open-interest-history wins over open-interest
      const key = Object.keys(bodies)
        .sort((a, b) => b.length - a.length)
        .find(k => u.includes(k))
      return new Response(
        JSON.stringify(key ? { code: '0', data: bodies[key] } : { code: '404' }),
        { status: key ? 200 : 404 },
      )
    })

    const d = await okxDerivatives('ETHUSDT')
    expect(d.longShortRatioKind).toBe('global_accounts')
    expect(d.longShortRatio).toBeCloseTo(1.50, 4) // latest account ratio
    expect(d.topPositionRatio).toBeCloseTo(0.90, 4)

    const hist = d.history ?? []
    expect(hist.length).toBeGreaterThan(5)
    const topVals = hist.map(h => h.topPositionRatio).filter((v): v is number => v !== null && v !== undefined)
    const uniqueTop = new Set(topVals.map(v => v.toFixed(4)))
    expect(uniqueTop.size).toBeGreaterThan(1)

    const lsVals = hist.map(h => h.longShortRatio).filter((v): v is number => v !== null && v !== undefined)
    expect(lsVals.length).toBeGreaterThan(0)
    expect(lsVals.every(v => v === null)).toBe(false)
    const uniqueLs = new Set(lsVals.map(v => v.toFixed(4)))
    expect(uniqueLs.size).toBeGreaterThan(1)

    // Newest hist bar (last after reverse) aligns to newest top=0.90 / ls=1.50
    const newest = hist[hist.length - 1]!
    expect(newest.topPositionRatio).toBeCloseTo(0.90, 4)
    expect(newest.longShortRatio).toBeCloseTo(1.50, 4)
    // sell=0 on newest → history must NOT get sentinel 99
    expect(newest.takerBuySellRatio).not.toBe(99)
    expect(newest.takerBuySellRatio).toBeNull()
  })
})
