import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Timeframe } from '@dsh-trading/market-data'
import { chartCandles } from './chart-payload.js'
import type { ChartPayload, ChartTimeframeData, ChartZoneAnnotation } from './chart-payload.js'
import { detectSupplyDemandZones, SUPPLY_DEMAND_RULES } from './supply-demand.js'

/** Separate from OB/FVG/sweep rules, and from arbitrary model-authored price bands. */
export function registerSupplyDemandTool(ctx: Context, timeframes: readonly Timeframe[]): void {
  ctx.tools.register(defineTool({
    name: 'find_supply_demand_zones',
    description: 'Find rule-defined supply/demand CANDIDATES from closed candles: a contracted 1-6 candle base followed within 3 bars by a directional close at least 1.5 pre-base ATR beyond its edge, including an impulse body. Returns actual base/confirmation times, frozen bounds, independent return counts and closed distal-break invalidations. Publishes formation-anchored boxes; never infers resting orders or converts arbitrary swing highs/broken supports into supply. Empty results are valid. OB/FVG/sweep rules are a separate indicator.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Instrument symbol exactly as list_symbols reports it.' },
      timeframe: { type: 'string', required: true, enum: [...timeframes], description: 'Native source timeframe. Query each required timeframe separately.' },
      bars: { type: 'integer', description: 'Historical window, 30-1000 bars; defaults to 500. The possibly forming tail is excluded.' },
      maxZones: { type: 'integer', description: 'Maximum active candidates displayed, 1-12; defaults to 6, nearest price first.' },
      provider: { type: 'string', description: 'Provider id; omit for the symbol default.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          symbol: { type: 'string', required: true },
          timeframe: { type: 'string', required: true },
          asOf: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          rules: { type: 'json', required: true },
          zones: { type: 'json', required: true },
          invalidated: { type: 'json', required: true },
          chart: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
      presentationMeta: (_args, value) => {
        const chart = value.chart as ChartTimeframeData | null
        if (chart === null) return {}
        const payload: ChartPayload = {
          kind: 'chart', version: 1, provider: value.provider, symbol: value.symbol, timeframes: [chart], replaceMarks: true,
        }
        return payload
      },
    },
    async execute(args) {
      const bars = args.bars ?? 500
      const maxZones = args.maxZones ?? 6
      if (!Number.isInteger(bars) || bars < 30 || bars > 1000) throw new Error('bars must be an integer in 30..1000')
      if (!Number.isInteger(maxZones) || maxZones < 1 || maxZones > 12) throw new Error('maxZones must be an integer in 1..12')
      const timeframe = args.timeframe as Timeframe
      const provider = ctx.marketData.resolveProvider(args.symbol, args.provider)
      const candles = await provider.getOhlcv({ symbol: args.symbol, timeframe, limit: bars })
      if (candles.length < 16) throw new Error('not enough candles for base/departure analysis')
      const all = detectSupplyDemandZones(candles)
      const lastClosed = candles[candles.length - 2]!
      const distance = (z: { low: number; high: number }): number =>
        Math.max(z.low - lastClosed.close, lastClosed.close - z.high, 0)
      const zones = all.filter(z => z.status !== 'invalidated')
        .sort((a, b) => distance(a) - distance(b) || b.confirmedIndex - a.confirmedIndex).slice(0, maxZones)
        .map(z => ({ ...z, availableAt: candles[z.confirmedIndex + 1]!.time, id: `${provider.id}:${args.symbol}:${timeframe}:${z.id}` }))
      const invalidated = all.filter(z => z.status === 'invalidated').slice(-maxZones)
        .map(z => ({ ...z, availableAt: candles[z.confirmedIndex + 1]!.time, id: `${provider.id}:${args.symbol}:${timeframe}:${z.id}` }))
      const annotations: ChartZoneAnnotation[] = zones.map(z => ({
        type: 'zone', low: z.low, high: z.high,
        label: `${timeframe}${z.kind === 'supply' ? '供给' : '需求'}候选·${z.status === 'fresh' ? '未回测' : `已回测${z.testCount}次`}`,
        role: z.kind === 'supply' ? 'resistance' : 'support',
        startTime: z.baseStartTime, confirmedAt: z.confirmedAt, availableAt: z.availableAt,
        sources: [
          `规则 ${SUPPLY_DEMAND_RULES.version}；${provider.id}:${args.symbol} @ ${timeframe}`,
          `基底 ${z.baseStartTime} → ${z.baseEndTime}；形成后固定边界 ${z.low}–${z.high}`,
          `离开确认K线 ${z.confirmedAt}；${z.displacementAtr.toFixed(2)}×基底前ATR14 (${z.atr})`,
          `截至已收盘 ${lastClosed.time}；独立回测${z.testCount}次；远端收盘越界即失效`,
        ],
      }))
      const drawable = chartCandles(candles, bars)
      const chart: ChartTimeframeData | null = drawable === null ? null : {
        timeframe, candles: drawable, indicators: null, annotations,
      }
      const lines = zones.map(z => `- ${timeframe} ${z.kind === 'supply' ? '供给' : '需求'}候选 ${z.low}–${z.high}；基底 ${z.baseStartTime} → ${z.baseEndTime}；确认 ${z.confirmedAt}；离开 ${z.displacementAtr.toFixed(2)} ATR；${z.status === 'fresh' ? '未回测' : `独立回测${z.testCount}次`}`)
      return {
        provider: provider.id, symbol: args.symbol, timeframe, asOf: lastClosed.time,
        rules: SUPPLY_DEMAND_RULES, zones, invalidated, chart,
        summary: [
          `### 供需候选 ${args.symbol} @ ${timeframe}（截至已收盘 ${lastClosed.time}）`,
          '规则：收缩基底1–6根，3根内离开≥1.5×基底前ATR14且含方向实体；末根不参与确认/回测/失效。',
          `显示 ${zones.length} 个有效候选；窗口内已失效 ${all.filter(z => z.status === 'invalidated').length} 个。`,
          ...(lines.length ? lines : ['未找到符合规则的候选；不以摆动点或旧支撑凑数。']),
          '这是OHLC规则候选，不是实际挂单证明；已回测不等于更可靠，反应与成交结果未验证。',
        ].join('\n'),
      }
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: `Supply/demand candidates: ${args.symbol} @ ${args.timeframe}`, kind: 'read', rawInput: args }),
  }))
}
