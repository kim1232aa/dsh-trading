import { describe, expect, it } from 'vitest'
import type { Candle, OhlcvQuery, Timeframe } from '@dsh-trading/market-data'
import { barDurationMs, parseArtifact, TIMEFRAME_MS, type BacktestArtifact } from '../src/artifact.js'
import { apply } from '../src/index.js'
import type { VerdictReport } from '../src/report.js'

const DAY = 86_400_000
const fixedPeriods: [Exclude<Timeframe, '1M'>, number][] = [
  ['1m', 60_000], ['3m', 180_000], ['5m', 300_000], ['15m', 900_000],
  ['30m', 1_800_000], ['1h', 3_600_000], ['2h', 7_200_000], ['4h', 14_400_000],
  ['6h', 21_600_000], ['8h', 28_800_000], ['12h', 43_200_000],
  ['1d', DAY], ['3d', 3 * DAY], ['1w', 7 * DAY],
]
const months = [
  ['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 31],
  ['2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', 28],
  ['2024-02-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z', 29],
  ['2026-04-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', 30],
  ['2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 31],
] as const

function artifact(timeframe: Timeframe, entryTime: string, exitTime: string): BacktestArtifact {
  return { version: 1, symbol: 'TEST', timeframe, trades: [
    { entryTime, exitTime, side: 'long', entryPrice: 100, exitPrice: 101 },
  ] }
}

interface AuditTool {
  name: string
  execute: (args: { artifactJson: string }, exec: unknown) => Promise<VerdictReport>
}

// Execute the registered tool, rather than only checking the helper: fetch padding,
// fill validation and independent-trade mapping must all use the correct boundary.
async function audit(value: BacktestArtifact, barOpen: string) {
  const requests: OhlcvQuery[] = []
  const tools = new Map<string, AuditTool>()
  const bar: Candle = { time: barOpen, open: 100, high: 105, low: 95, close: 102, volume: 100 }
  const ctx = {
    tools: { register: (tool: AuditTool) => tools.set(tool.name, tool) },
    marketData: {
      resolveProvider: () => ({ id: 'fixture' }),
      getOhlcv: async (query: OhlcvQuery) => {
        requests.push(query)
        return [bar].filter(b => Date.parse(b.time) >= Date.parse(query.start!) && Date.parse(b.time) <= Date.parse(query.end!))
      },
    },
  }
  apply(ctx as never, { simulations: 10, seed: 42 })
  const report = await tools.get('audit_backtest')!.execute({ artifactJson: JSON.stringify(value) }, {})
  return { report, request: requests[0]! }
}

function check(report: VerdictReport, id: string) {
  const result = report.checks.find(item => item.id === id)
  expect(result).toBeDefined()
  return result!
}

describe('timeframe coverage', () => {
  it.each(fixedPeriods)('maps and audits %s without changing its duration', async (timeframe, duration) => {
    const open = '2026-01-01T00:00:00.000Z'
    expect(TIMEFRAME_MS[timeframe]).toBe(duration)
    expect(barDurationMs(timeframe, open)).toBe(duration)
    const entry = new Date(Date.parse(open) + duration / 2).toISOString()
    const exit = new Date(Date.parse(open) + duration - 1).toISOString()
    const value = artifact(timeframe, entry, exit)
    expect(parseArtifact(value)).toEqual(value)
    const { report } = await audit(value, open)
    expect(check(report, 'fill-validation').status).not.toBe('error')
    expect(check(report, 'independence').status).toBe('pass')
    const outside = await audit(artifact(timeframe, entry, new Date(Date.parse(open) + duration).toISOString()), open)
    expect(check(outside.report, 'fill-validation').status).toBe('error')
    expect(check(outside.report, 'independence').summary).toBe('0 independent same-side windows out of 1 reported trades')
  })

  it('keeps minute and calendar month distinct and rejects inherited object keys', () => {
    expect(TIMEFRAME_MS['1m']).toBe(60_000)
    expect(TIMEFRAME_MS['1M']).toBeNull()
    const value = artifact('1M', months[0][0], months[0][1])
    expect(parseArtifact(value).timeframe).toBe('1M')
    for (const timeframe of ['2d', '1mo', 'toString', 'constructor', '__proto__']) {
      expect(() => parseArtifact({ ...value, timeframe })).toThrow(/artifact.timeframe/)
    }
    expect(Object.keys(TIMEFRAME_MS).sort()).toEqual([...fixedPeriods.map(([tf]) => tf), '1M'].sort())
  })
})

describe('calendar-month audit boundary', () => {
  it.each(months)('uses the real month starting %s', async (open, close, days) => {
    expect(barDurationMs('1M', open)).toBe(days * DAY)
    const inside = new Date(Date.parse(close) - 1).toISOString()
    const valid = await audit(artifact('1M', inside, inside), open)
    expect(Date.parse(valid.request.start!)).toBeLessThanOrEqual(Date.parse(open))
    expect(Date.parse(valid.request.end!)).toBeGreaterThanOrEqual(Date.parse(close))
    expect(check(valid.report, 'fill-validation').status).not.toBe('error')
    expect(check(valid.report, 'independence').status).toBe('pass')
    const outside = await audit(artifact('1M', inside, close), open)
    expect(check(outside.report, 'fill-validation').status).toBe('error')
    expect(check(outside.report, 'independence').summary).toBe('0 independent same-side windows out of 1 reported trades')
  })
})
