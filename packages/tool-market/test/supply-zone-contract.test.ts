import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import type { Candle } from '@dsh-trading/market-data'
import type { ChartPayload } from '../src/chart-payload.js'

type RegisteredTool = {
  execute: (args: unknown, exec: unknown) => Promise<unknown>
  output: {
    presentationMeta?: (args: unknown, value: never) => unknown
    render: (args: unknown, value: never) => { type: string; text?: string }[]
  }
}

function tools(input?: Candle[]) {
  const registered = new Map<string, RegisteredTool>()
  const candles = Array.from({ length: 40 }, (_, i) => ({
    time: new Date(Date.UTC(2026, 0, 1, 0, i * 5)).toISOString(),
    open: 100, high: 102, low: 98, close: 100, volume: 100,
  }))
  const provider = { id: 'fixture', getOhlcv: async () => input ?? candles }
  apply({ tools: { register: (def: { name: string } & RegisteredTool) => registered.set(def.name, def) },
    marketData: { resolveProvider: () => provider } } as never, { chartDir: './charts' })
  return registered
}

function formation(): Candle[] {
  const bar = (i: number, open = 100, high = 102, low = 98, close = 100): Candle => ({
    time: new Date(Date.UTC(2026, 0, 1, 0, i * 5)).toISOString(), open, high, low, close, volume: 100,
  })
  return [...Array.from({ length: 14 }, (_, i) => bar(i)),
    bar(14, 100, 101, 99, 100.5), bar(15, 100, 100.5, 90, 91),
    bar(16, 91, 101.5, 90, 101.25)]
}

describe('supply zone tool contract', () => {
  it('provides a dedicated evidence-based supply/demand query', () => {
    expect(tools().has('find_supply_demand_zones')).toBe(true)
  })
  it.each(['15m供给区', 'demand zone', '已破支撑转供给'])('accepts supply/demand and reference bands called %s per upstream contract', async label => {
    const tool = tools().get('annotate_chart')!
    await expect(tool.execute({ symbol: 'DEMO', timeframe: '5m',
      zones: [{ low: 100, high: 101, label, role: 'resistance', sources: ['prior swing high'] }],
    }, {})).resolves.toBeDefined()
  })
  it('continues to accept ordinary support/resistance references', async () => {
    await expect(tools().get('annotate_chart')!.execute({ symbol: 'DEMO', timeframe: '5m',
      zones: [{ low: 100, high: 101, label: '前高压力参考', sources: ['prior swing high'] }],
    }, {})).resolves.toBeDefined()
  })
  it('publishes a base origin and a post-close availability boundary in actual chart metadata', async () => {
    const candles = formation()
    const tool = tools(candles).get('find_supply_demand_zones')!
    const value = await tool.execute({ symbol: 'DEMO', timeframe: '5m' }, {}) as {
      zones: { baseStart: number; status: string; availableAt: string }[]
    }
    expect(value.zones.find(z => z.baseStart === 14)).toMatchObject({ status: 'fresh', availableAt: candles[16]!.time })
    const payload = tool.output.presentationMeta!({}, value as never) as ChartPayload
    expect(payload.kind).toBe('chart')
    expect(payload.replaceMarks).toBe(true)
    expect(payload.timeframes[0]!.annotations![0]).toMatchObject({
      type: 'zone', role: 'resistance', low: 100, high: 101,
      startTime: candles[14]!.time, confirmedAt: candles[15]!.time, availableAt: candles[16]!.time,
    })
    expect(tool.output.render({}, value as never)[0]!.text).not.toContain('"candles"')
  })
  it('publishes an explicit empty replacement after a confirmed distal break', async () => {
    const candles = formation()
    candles.push({ ...candles[16]!, time: '2026-01-01T01:25:00.000Z' })
    const tool = tools(candles).get('find_supply_demand_zones')!
    const value = await tool.execute({ symbol: 'DEMO', timeframe: '5m' }, {}) as {
      zones: unknown[]; invalidated: { status: string; invalidatedAt: string }[]
    }
    expect(value.zones).toEqual([])
    expect(value.invalidated[0]).toMatchObject({ status: 'invalidated', invalidatedAt: candles[16]!.time })
    const payload = tool.output.presentationMeta!({}, value as never) as ChartPayload
    expect(payload.replaceMarks).toBe(true)
    expect(payload.timeframes[0]!.annotations).toEqual([])
  })
})
