import { describe, expect, it } from 'vitest'
import { contentText, readCallFallbackPayload, readChartPayload } from '../src/client/payload.js'

const candle = { time: '2024-01-01T00:00:00.000Z', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }

function payload(): Record<string, unknown> {
  return {
    kind: 'chart',
    version: 1,
    provider: 'csv',
    symbol: 'DEMO',
    timeframes: [{ timeframe: '1d', candles: [candle], indicators: { close: 1.5 } }],
  }
}

describe('readChartPayload', () => {
  it('accepts a well-formed payload', () => {
    const p = readChartPayload(payload())
    expect(p).not.toBeNull()
    expect(p!.timeframes[0]!.candles[0]!.close).toBe(1.5)
  })

  it('preserves the current v1 scenario contract', () => {
    const p = payload()
    p['scenarios'] = [{
      direction: 'bull',
      stance: 'base',
      thesis: 'price holds support',
      trigger: 'close above resistance',
      invalidation: 'close below support',
      triggerPrice: 2,
      invalidationPrice: 1,
    }]

    expect(readChartPayload(p)?.scenarios).toEqual([{
      direction: 'bull',
      stance: 'base',
      thesis: 'price holds support',
      trigger: 'close above resistance',
      invalidation: 'close below support',
      triggerPrice: 2,
      invalidationPrice: 1,
    }])
  })

  it('drops scenarios that do not carry a v1 stance', () => {
    const p = payload()
    p['scenarios'] = [{
      direction: 'bull',
      weight: 0.6,
      thesis: 'legacy shape',
      trigger: 'x',
      invalidation: 'y',
    }]

    expect(readChartPayload(p)?.scenarios).toBeUndefined()
  })

  it('rejects absent, foreign, and wrong-version metas', () => {
    expect(readChartPayload(undefined)).toBeNull()
    expect(readChartPayload(null)).toBeNull()
    expect(readChartPayload({ kind: 'diff' })).toBeNull()
    expect(readChartPayload({ ...payload(), version: 2 })).toBeNull()
  })

  it('drops malformed timeframes and rejects when none survive', () => {
    const p = payload()
    p['timeframes'] = [
      { timeframe: '1d', candles: [candle], indicators: null },
      { timeframe: '4h', candles: [{ ...candle, close: 'oops' }], indicators: null },
    ]
    const read = readChartPayload(p)
    expect(read!.timeframes).toHaveLength(1)

    p['timeframes'] = [{ timeframe: '1d', candles: [], indicators: null }]
    expect(readChartPayload(p)).toBeNull()
  })
})

describe('contentText', () => {
  it('flattens nested text blocks', () => {
    const content = [
      { type: 'text', text: 'outer' },
      { type: 'tool-result', toolCallId: 'x', content: [{ type: 'text', text: 'inner' }] },
    ]
    expect(contentText(content)).toBe('outer\ninner')
  })

  it('returns empty for non-arrays and deep nesting', () => {
    expect(contentText('nope')).toBe('')
  })
})

describe('readCallFallbackPayload', () => {
  it('reconstructs symbol, timeframe, and annotations from nested run_code call argsRaw', () => {
    const p = readCallFallbackPayload({
      name: 'annotate_chart',
      argsRaw: JSON.stringify({
        symbol: 'ETHUSDT',
        timeframe: '5m',
        levels: [{ price: 2244.6, label: '颈线', role: 'support', sources: ['s'] }],
        zones: [{ low: 2218, high: 2225, label: '买墙区', role: 'support', sources: ['s'] }],
        paths: [{ points: [{ time: '2026-11-03T00:00:00.000Z', price: 2250 }, { time: '2026-11-03T04:00:00.000Z', price: 2223, note: 'L2' }], label: '剧本', role: 'target', sources: ['s'] }],
        scenarios: [{ direction: 'bear', stance: 'base', thesis: 't', trigger: 'a', invalidation: 'b', triggerPrice: 2244.6 }],
      }),
    })
    expect(p).not.toBeNull()
    expect(p?.symbol).toBe('ETHUSDT')
    expect(p?.provider).toBe('binance')
    expect(p?.timeframes[0]?.timeframe).toBe('5m')
    expect(p?.timeframes[0]?.annotations).toHaveLength(3)
    expect(p?.scenarios).toHaveLength(1)
  })

  it('rejects non-chart tool calls and malformed args', () => {
    expect(readCallFallbackPayload({ name: 'web_search', argsRaw: '{}' })).toBeNull()
    expect(readCallFallbackPayload({ name: 'get_ohlcv', argsRaw: 'not-json' })).toBeNull()
  })
})
