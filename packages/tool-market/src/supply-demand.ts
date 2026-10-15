import type { Candle } from '@dsh-trading/market-data'

export type SupplyDemandZone = {
  id: string
  kind: 'supply' | 'demand'
  low: number
  high: number
  baseStart: number
  baseEnd: number
  baseStartTime: string
  baseEndTime: string
  confirmedIndex: number
  confirmedAt: string
  atr: number
  displacementAtr: number
  status: 'fresh' | 'tested' | 'invalidated'
  testCount: number
  invalidatedAt?: string
}
export type SupplyDemandOptions = {
  atrPeriod?: number
  maxBaseBars?: number
  maxDepartureBars?: number
  minDisplacementAtr?: number
  /** Unknown/live tail is excluded unless explicitly known to be closed. */
  lastBarClosed?: boolean
}

/** Explicit OHLC heuristic, not an observation of resting orders or future reactions. */
export const SUPPLY_DEMAND_RULES = {
  version: 'base-departure-v1',
  atrPeriod: 14, maxBaseBars: 6, maxDepartureBars: 3, minDisplacementAtr: 1.5,
  maxBaseBodyFraction: 0.5, maxBaseBarAtr: 0.8, maxBaseRangeAtr: 1,
  minImpulseBodyAtr: 0.8, minImpulseBodyFraction: 0.6,
} as const

function integer(name: string, value: number, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer in 1..${max}`)
  return value
}

/** Only closed candles contribute to formation, tests, and invalidation. */
export function detectSupplyDemandZones(
  candles: readonly Candle[], options: SupplyDemandOptions = {},
): SupplyDemandZone[] {
  const period = integer('atrPeriod', options.atrPeriod ?? 14, 200)
  const maxBase = integer('maxBaseBars', options.maxBaseBars ?? 6, 12)
  const maxDeparture = integer('maxDepartureBars', options.maxDepartureBars ?? 3, 6)
  const minMove = options.minDisplacementAtr ?? 1.5
  if (!Number.isFinite(minMove) || minMove < 1 || minMove > 10) throw new Error('minDisplacementAtr must be in 1..10')
  const n = Math.max(0, candles.length - (options.lastBarClosed === true ? 0 : 1))
  const volatility: (number | null)[] = []
  const ranges: number[] = []
  let sum = 0
  let previousTime = -Infinity
  for (let i = 0; i < n; i++) {
    const b = candles[i]!
    const time = Date.parse(b.time)
    if (![b.open, b.high, b.low, b.close, time].every(Number.isFinite) || time <= previousTime ||
      b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close) || b.high < b.low) {
      throw new Error(`Invalid OHLC/time at candle ${i}`)
    }
    previousTime = time
    const prevClose = i > 0 ? candles[i - 1]!.close : b.close
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose))
    ranges.push(tr)
    sum += tr
    if (i >= period) sum -= ranges[i - period]!
    volatility.push(i >= period - 1 ? sum / period : null)
  }
  const zones: SupplyDemandZone[] = []
  for (let end = period; end < n - 1; end++) {
    let base: { start: number; low: number; high: number; atr: number } | undefined
    // Prefer the longest contracted base; never merge unrelated swing prices.
    for (let start = Math.max(period, end - maxBase + 1); start <= end; start++) {
      const atr = volatility[start - 1]
      if (atr === null || atr === undefined || atr <= 0) continue
      let low = Infinity
      let high = -Infinity
      let valid = true
      for (let k = start; k <= end; k++) {
        const b = candles[k]!
        const range = b.high - b.low
        if (range <= 0 || range / atr > SUPPLY_DEMAND_RULES.maxBaseBarAtr + 1e-12 ||
          Math.abs(b.close - b.open) / range > SUPPLY_DEMAND_RULES.maxBaseBodyFraction + 1e-12) {
          valid = false
          break
        }
        low = Math.min(low, b.low)
        high = Math.max(high, b.high)
      }
      if (valid && (high - low) / atr <= SUPPLY_DEMAND_RULES.maxBaseRangeAtr + 1e-12) {
        base = { start, low, high, atr }
        break
      }
    }
    if (!base) continue
    for (const kind of ['supply', 'demand'] as const) {
      const direction = kind === 'supply' ? -1 : 1
      let hasImpulse = false
      for (let i = end + 1; i <= Math.min(n - 1, end + maxDeparture); i++) {
        const b = candles[i]!
        // An opposite departure invalidates this formation hypothesis.
        if ((direction === -1 && b.close > base.high) || (direction === 1 && b.close < base.low)) break
        const body = direction * (b.close - b.open)
        const range = b.high - b.low
        hasImpulse ||= body / base.atr >= SUPPLY_DEMAND_RULES.minImpulseBodyAtr &&
          range > 0 && body / range >= SUPPLY_DEMAND_RULES.minImpulseBodyFraction
        const displacementAtr = (direction === -1 ? base.low - b.close : b.close - base.high) / base.atr
        if (!hasImpulse || displacementAtr < minMove) continue
        const baseBars = candles.slice(base.start, end + 1)
        const low = kind === 'supply' ? Math.min(...baseBars.map(v => Math.min(v.open, v.close))) : base.low
        const high = kind === 'supply' ? base.high : Math.max(...baseBars.map(v => Math.max(v.open, v.close)))
        if (high <= low) break
        const z: SupplyDemandZone = {
          id: `${kind}:${candles[base.start]!.time}:${candles[end]!.time}:${b.time}`,
          kind, low, high, baseStart: base.start, baseEnd: end,
          baseStartTime: candles[base.start]!.time, baseEndTime: candles[end]!.time,
          confirmedIndex: i, confirmedAt: b.time, atr: base.atr, displacementAtr,
          status: 'fresh', testCount: 0,
        }
        const duplicate = zones.findIndex(v => v.kind === kind && v.confirmedIndex === i &&
          v.baseStart <= end && v.baseEnd >= base!.start)
        if (duplicate < 0) zones.push(z)
        else if (end - base.start > zones[duplicate]!.baseEnd - zones[duplicate]!.baseStart) zones[duplicate] = z
        break
      }
    }
  }
  for (const z of zones) {
    let wasInside = false
    for (let i = z.confirmedIndex + 1; i < n; i++) {
      const b = candles[i]!
      if ((z.kind === 'supply' && b.close > z.high) || (z.kind === 'demand' && b.close < z.low)) {
        z.status = 'invalidated'
        z.invalidatedAt = b.time
        break
      }
      const inside = b.high >= z.low && b.low <= z.high
      if (inside && !wasInside) {
        z.testCount++
        z.status = 'tested'
      }
      wasInside = inside
    }
  }
  return zones
}
