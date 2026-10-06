/**
 * Order Block & Breaker Block Zone
 * Faithful TypeScript translation of the TradingView Pine Script v6 indicator
 * by RWBTradeLab.
 *
 * 4-Step Order Block Rules:
 *  1. Sweep of previous candle extreme (low for bull, high for bear)
 *  2. 3-candle imbalance (FVG gap)
 *  3. Clean zone (price does not trade back during wait)
 *  4. Structure break (BOS / CHoCH over swing pivots within wait window)
 *
 * Lifecycle:
 *  Fresh -> Mitigated -> Breaker Block (failed block flips polarity)
 */

import { formatPrice } from '../precision.js'

export interface Candle {
  open?: number
  high: number
  low: number
  close: number
  timestamp?: number
}

export type ZoneState = 'pending' | 'fresh' | 'mitigated' | 'breaker'
export type Polarity = 'bullish' | 'bearish'

export interface OrderBlockZone {
  id: number
  obBar: number // Candle 1 index (the Order Block candle)
  c3Bar: number // Candle 3 index (imbalance completion)
  confirmBar?: number | undefined // Bar index when structure break confirmed the zone
  breakBar?: number | undefined // Bar index when zone was broken (flip to Breaker)
  top: number // Zone upper price (Candle 1 high)
  bot: number // Zone lower price (Candle 1 low)
  fvgFar: number // Far edge of imbalance (Candle 3 low for bull, high for bear)
  swPrice?: number | undefined // Confirming swing pivot price level
  swBar?: number | undefined // Confirming swing pivot bar index
  dir: 1 | -1 // Original OB direction: 1 = Bullish OB, -1 = Bearish OB
  state: ZoneState
  choch: boolean // true = CHoCH (reversal), false = BOS (continuation)
  deadline: number // Maximum bar index allowed to wait for structure break
  left: number // Display start bar (obBar or breakBar depending on bbAnchor)
  tag: string // Human-readable tag, e.g. "Bull OB (BOS)", "Bearish Breaker"
  polarity: Polarity // Current polarity (Breaker blocks flip: bull OB -> bearish breaker)
}

export interface ZoneCounts {
  freshBull: number
  freshBear: number
  mitBull: number
  mitBear: number
  bbBull: number
  bbBear: number
}

export interface ZoneSignals {
  bullOB: boolean
  bearOB: boolean
  bullMit: boolean
  bearMit: boolean
  bullBB: boolean
  bearBB: boolean
}

export interface OrderBlockBarResult {
  // Key levels for chart plotting:
  bullOB?: number | undefined // Midpoint of latest active bullish OB
  bearOB?: number | undefined // Midpoint of latest active bearish OB
  breaker?: number | undefined // Midpoint of latest active breaker block

  // Detailed bounds of latest active zones:
  bullOBTop?: number | undefined
  bullOBBot?: number | undefined
  bearOBTop?: number | undefined
  bearOBBot?: number | undefined
  breakerTop?: number | undefined
  breakerBot?: number | undefined

  // Summary counts across all tracked zones:
  counts: ZoneCounts

  // Discrete signals fired on this bar:
  signals: ZoneSignals

  // All active zones visible on this bar (governed by maxOB/maxBB):
  activeZones: OrderBlockZone[]
}

export interface OrderBlockOptions {
  swingL?: number // Swing Left (default 5)
  swingR?: number // Swing Right (default 5)
  candleLen?: number // Scan length in closed candles (default 500)
  maxOB?: number // Max Order Blocks shown (default 5)
  maxBB?: number // Max Breaker Blocks shown (default 5)
  waitBars?: number // Structure break wait candles (default 20)
  showBullOB?: boolean // default true
  showBearOB?: boolean // default true
  showMitOB?: boolean // default true
  showBullBB?: boolean // default true
  showBearBB?: boolean // default true
  showFVG?: boolean // default true
  showConfSw?: boolean // default true
  bbAnchor?: 'Breakout Candle' | 'Order Block Candle' // default 'Breakout Candle'
  extendZones?: boolean // default true
}

const MAX_ZONES = 200

/**
 * Checks if bar p is a pivot high over [p - swingL, p + swingR].
 */
function isPivotHigh(bars: readonly Candle[], p: number, swingL: number, swingR: number): boolean {
  if (p < swingL || p + swingR >= bars.length) return false
  const pHigh = bars[p]!.high
  for (let j = p - swingL; j < p; j++) {
    if (bars[j]!.high >= pHigh) return false
  }
  for (let j = p + 1; j <= p + swingR; j++) {
    if (bars[j]!.high > pHigh) return false
  }
  return true
}

/**
 * Checks if bar p is a pivot low over [p - swingL, p + swingR].
 */
function isPivotLow(bars: readonly Candle[], p: number, swingL: number, swingR: number): boolean {
  if (p < swingL || p + swingR >= bars.length) return false
  const pLow = bars[p]!.low
  for (let j = p - swingL; j < p; j++) {
    if (bars[j]!.low <= pLow) return false
  }
  for (let j = p + 1; j <= p + swingR; j++) {
    if (bars[j]!.low < pLow) return false
  }
  return true
}

function getZoneTag(z: OrderBlockZone): string {
  if (z.state === 'fresh') {
    const base = z.dir === 1 ? 'Bull OB' : 'Bear OB'
    return `${base} (${z.choch ? 'CHoCH' : 'BOS'})`
  }
  if (z.state === 'mitigated') {
    return z.dir === 1 ? 'Bull OB mitigated' : 'Bear OB mitigated'
  }
  if (z.state === 'breaker') {
    return z.dir === -1 ? 'Bullish Breaker' : 'Bearish Breaker'
  }
  return 'Pending OB'
}

/** Canvas label only; 	ag itself stays English because callers/tests key on it. */
function zhZoneTag(tag: string): string {
  return tag
    .replace('Bull OB mitigated', '买单块(已回补)').replace('Bear OB mitigated', '卖单块(已回补)')
    .replace('Bullish Breaker', '看多破坏块').replace('Bearish Breaker', '看空破坏块')
    .replace('Bull OB', '买单块').replace('Bear OB', '卖单块').replace('Pending OB', '待确认块')
    .replace('CHoCH', '转势').replace('BOS', '破结构')
}

function getZonePolarity(z: OrderBlockZone): Polarity {
  if (z.state === 'breaker') {
    return z.dir === -1 ? 'bullish' : 'bearish'
  }
  return z.dir === 1 ? 'bullish' : 'bearish'
}

function isZoneVisible(z: OrderBlockZone, opts: Required<OrderBlockOptions>): boolean {
  if (z.state === 'fresh') {
    return z.dir === 1 ? opts.showBullOB : opts.showBearOB
  }
  if (z.state === 'mitigated') {
    return opts.showMitOB
  }
  if (z.state === 'breaker') {
    return z.dir === -1 ? opts.showBullBB : opts.showBearBB
  }
  return false
}

/**
 * Pure calculation function for Order Blocks & Breaker Blocks.
 * Simulates bar-by-bar matching Pine Script v6 execution.
 */
export function calculateOrderBlocks(
  candles: readonly Candle[],
  options?: OrderBlockOptions,
): OrderBlockBarResult[] {
  const n = candles.length
  if (n === 0) return []

  const opts: Required<OrderBlockOptions> = {
    swingL: options?.swingL ?? 5,
    swingR: options?.swingR ?? 5,
    candleLen: options?.candleLen ?? 500,
    maxOB: options?.maxOB ?? 5,
    maxBB: options?.maxBB ?? 5,
    waitBars: options?.waitBars ?? 20,
    showBullOB: options?.showBullOB ?? true,
    showBearOB: options?.showBearOB ?? true,
    showMitOB: options?.showMitOB ?? true,
    showBullBB: options?.showBullBB ?? true,
    showBearBB: options?.showBearBB ?? true,
    showFVG: options?.showFVG ?? true,
    showConfSw: options?.showConfSw ?? true,
    bbAnchor: options?.bbAnchor ?? 'Breakout Candle',
    extendZones: options?.extendZones ?? true,
  }

  const results: OrderBlockBarResult[] = new Array(n)

  // Market structure state
  let swHigh: number | undefined
  let swHighBar: number | undefined
  let swHighUsed = true
  let swLow: number | undefined
  let swLowBar: number | undefined
  let swLowUsed = true
  let mss = 0 // 1 = Bullish, -1 = Bearish, 0 = None

  let lastUpBar = -1
  let lastUpChoch = false
  let lastUpLevel: number | undefined
  let lastUpLvlBar: number | undefined

  let lastDnBar = -1
  let lastDnChoch = false
  let lastDnLevel: number | undefined
  let lastDnLvlBar: number | undefined

  const zones: OrderBlockZone[] = []
  let nextZoneId = 1

  const scanStartBar = Math.max(3, n - 1 - opts.candleLen)

  for (let i = 0; i < n; i++) {
    const cur = candles[i]!
    const curOpen = cur.open ?? cur.close

    let sigBullOB = false
    let sigBearOB = false
    let sigBullMit = false
    let sigBearMit = false
    let sigBullBB = false
    let sigBearBB = false

    // 1. Market structure
    const pIdx = i - opts.swingR
    if (pIdx >= opts.swingL) {
      if (isPivotHigh(candles, pIdx, opts.swingL, opts.swingR)) {
        swHigh = candles[pIdx]!.high
        swHighBar = pIdx
        swHighUsed = false
      }
      if (isPivotLow(candles, pIdx, opts.swingL, opts.swingR)) {
        swLow = candles[pIdx]!.low
        swLowBar = pIdx
        swLowUsed = false
      }
    }

    let upBreak = swHigh !== undefined && !swHighUsed && cur.close > swHigh
    let dnBreak = swLow !== undefined && !swLowUsed && cur.close < swLow

    if (upBreak && dnBreak) {
      if (cur.close > curOpen) {
        dnBreak = false
      } else {
        upBreak = false
      }
    }

    let upChoch = false
    let dnChoch = false

    if (upBreak) {
      upChoch = mss === -1
      mss = 1
      swHighUsed = true
      lastUpBar = i
      lastUpChoch = upChoch
      lastUpLevel = swHigh
      lastUpLvlBar = swHighBar
    }

    if (dnBreak) {
      dnChoch = mss === 1
      mss = -1
      swLowUsed = true
      lastDnBar = i
      lastDnChoch = dnChoch
      lastDnLevel = swLow
      lastDnLvlBar = swLowBar
    }

    // 2. Advance every zone already on the books
    for (let idx = zones.length - 1; idx >= 0; idx--) {
      const z = zones[idx]!
      let drop = false

      // PENDING: waiting for structure break, zone must remain clean
      if (z.state === 'pending') {
        if (i > z.c3Bar) {
          const backInZone = z.dir === 1 ? cur.low <= z.top : cur.high >= z.bot
          if (backInZone) {
            drop = true
          }
        }

        if (!drop) {
          const brk = z.dir === 1 ? upBreak : dnBreak
          if (brk) {
            z.state = 'fresh'
            z.choch = z.dir === 1 ? upChoch : dnChoch
            z.confirmBar = i
            z.swPrice = z.dir === 1 ? lastUpLevel : lastDnLevel
            z.swBar = z.dir === 1 ? lastUpLvlBar : lastDnLvlBar
            if (z.dir === 1) sigBullOB = true
            else sigBearOB = true
          } else if (i >= z.deadline) {
            drop = true
          }
        }
      }

      // FRESH: alive until price trades back into it
      if (!drop && z.state === 'fresh') {
        const tapped = z.dir === 1 ? cur.low <= z.top : cur.high >= z.bot
        if (tapped) {
          z.state = 'mitigated'
          if (z.dir === 1) sigBullMit = true
          else sigBearMit = true
        }
      }

      // MITIGATED: waiting to be broken through far side
      // Tested on same bar as tap: one candle can dip in and close through opposite side
      if (!drop && z.state === 'mitigated') {
        const failed = z.dir === 1 ? cur.close < z.bot : cur.close > z.top
        if (failed) {
          z.state = 'breaker'
          z.breakBar = i
          if (z.dir === 1) sigBearBB = true
          else sigBullBB = true
        }
      }

      if (drop) {
        zones.splice(idx, 1)
      } else {
        z.polarity = getZonePolarity(z)
        z.tag = getZoneTag(z)
        z.left = (z.state === 'breaker' && opts.bbAnchor === 'Breakout Candle' && z.breakBar !== undefined)
          ? z.breakBar
          : z.obBar
      }
    }

    // 3. New imbalance completing on this candle
    if (i >= 3 && i >= scanStartBar) {
      const b0 = candles[i]!
      const b2 = candles[i - 2]!
      const b3 = candles[i - 3]!

      // Bullish: sweep previous low, gap above block
      const bullOK = b2.low < b3.low && b0.low > b2.high
      // Bearish: sweep previous high, gap below block
      const bearOK = b2.high > b3.high && b0.high < b2.low

      if (bullOK || bearOK) {
        const obDir: 1 | -1 = bullOK ? 1 : -1
        const nz: OrderBlockZone = {
          id: nextZoneId++,
          obBar: i - 2,
          c3Bar: i,
          confirmBar: i,
          breakBar: undefined,
          top: b2.high,
          bot: b2.low,
          fvgFar: obDir === 1 ? b0.low : b0.high,
          swPrice: undefined,
          swBar: undefined,
          dir: obDir,
          state: 'pending',
          choch: false,
          deadline: i + opts.waitBars,
          left: i - 2,
          tag: '',
          polarity: obDir === 1 ? 'bullish' : 'bearish',
        }

        // Check if displacement candle or current candle already broke structure
        const brkBar = obDir === 1 ? lastUpBar : lastDnBar
        const brkChoch = obDir === 1 ? lastUpChoch : lastDnChoch

        if (brkBar >= i - 1) {
          nz.state = 'fresh'
          nz.choch = brkChoch
          nz.confirmBar = brkBar
          nz.swPrice = obDir === 1 ? lastUpLevel : lastDnLevel
          nz.swBar = obDir === 1 ? lastUpLvlBar : lastDnLvlBar
          if (obDir === 1) sigBullOB = true
          else sigBearOB = true
        }

        nz.polarity = getZonePolarity(nz)
        nz.tag = getZoneTag(nz)

        zones.push(nz)
        if (zones.length > MAX_ZONES) {
          zones.shift()
        }
      }
    }

    // 4. Summarize and filter active zones for display (newest first)
    let cFreshBull = 0
    let cFreshBear = 0
    let cMitBull = 0
    let cMitBear = 0
    let cBBBull = 0
    let cBBBear = 0

    let obShown = 0
    let bbShown = 0
    const activeZones: OrderBlockZone[] = []

    for (let idx = zones.length - 1; idx >= 0; idx--) {
      const z = zones[idx]!

      // Table counts count ALL tracked non-pending zones
      if (z.state === 'fresh') {
        if (z.dir === 1) cFreshBull++
        else cFreshBear++
      } else if (z.state === 'mitigated') {
        if (z.dir === 1) cMitBull++
        else cMitBear++
      } else if (z.state === 'breaker') {
        if (z.dir === -1) cBBBull++
        else cBBBear++
      }

      let allowed = false
      if (z.state === 'fresh' || z.state === 'mitigated') {
        obShown++
        allowed = obShown <= opts.maxOB
      } else if (z.state === 'breaker') {
        bbShown++
        allowed = bbShown <= opts.maxBB
      }

      if (allowed && z.state !== 'pending' && isZoneVisible(z, opts)) {
        activeZones.push({ ...z })
      }
    }

    // ponytail: returns midpoint for line figures; upgrade to custom klinecharts polygon overlay if full colored boxes are requested on-canvas.
    // Extract latest active levels for simple line overlays
    let latestBullOB: OrderBlockZone | undefined
    let latestBearOB: OrderBlockZone | undefined
    let latestBreaker: OrderBlockZone | undefined

    for (const z of activeZones) {
      if (!latestBullOB && (z.state === 'fresh' || z.state === 'mitigated') && z.dir === 1) {
        latestBullOB = z
      }
      if (!latestBearOB && (z.state === 'fresh' || z.state === 'mitigated') && z.dir === -1) {
        latestBearOB = z
      }
      if (!latestBreaker && z.state === 'breaker') {
        latestBreaker = z
      }
      if (latestBullOB && latestBearOB && latestBreaker) break
    }

    results[i] = {
      bullOB: latestBullOB ? (latestBullOB.top + latestBullOB.bot) / 2 : undefined,
      bearOB: latestBearOB ? (latestBearOB.top + latestBearOB.bot) / 2 : undefined,
      breaker: latestBreaker ? (latestBreaker.top + latestBreaker.bot) / 2 : undefined,
      bullOBTop: latestBullOB?.top,
      bullOBBot: latestBullOB?.bot,
      bearOBTop: latestBearOB?.top,
      bearOBBot: latestBearOB?.bot,
      breakerTop: latestBreaker?.top,
      breakerBot: latestBreaker?.bot,
      counts: {
        freshBull: cFreshBull,
        freshBear: cFreshBear,
        mitBull: cMitBull,
        mitBear: cMitBear,
        bbBull: cBBBull,
        bbBear: cBBBear,
      },
      signals: {
        bullOB: sigBullOB,
        bearOB: sigBearOB,
        bullMit: sigBullMit,
        bearMit: sigBearMit,
        bullBB: sigBullBB,
        bearBB: sigBearBB,
      },
      activeZones,
    }
  }

  return results
}

/**
 * Drop-in backward compatible wrapper for simple line overlay consumption.
 */
export function orderBlockBreaker(
  bars: readonly { high: number; low: number; close: number; open?: number }[],
  options?: OrderBlockOptions,
): Pick<OrderBlockBarResult, 'bullOB' | 'bearOB' | 'breaker'>[] {
  return calculateOrderBlocks(bars, options)
}

/**
 * Klinecharts indicator registration definition for OB & BB Zone.
 */
export const orderBlockIndicator = {
  name: 'OB_BB',
  shortName: '订单块',
  series: 'price' as const,
  precision: 2,
  calcParams: [5, 5, 20],
  figures: [
    { key: 'bullOB', type: 'line' },
    { key: 'bearOB', type: 'line' },
    { key: 'breaker', type: 'line' },
  ],
  styles: {
    lines: [
      { color: '#22c55e', size: 2, style: 'solid', smooth: false, dashedValue: [2, 2] },
      { color: '#ef4444', size: 2, style: 'solid', smooth: false, dashedValue: [2, 2] },
      { color: '#a855f7', size: 2, style: 'dashed', smooth: false, dashedValue: [3, 3] },
    ],
  },
  calc: (dataList: Candle[], indicator?: { calcParams?: number[] }) => {
    const params = indicator?.calcParams ?? []
    return calculateOrderBlocks(dataList, {
      swingL: params[0] ?? 5,
      swingR: params[1] ?? 5,
      waitBars: params[2] ?? 20,
    })
  },
  createTooltipDataSource: ({ indicator, crosshair }: {
    indicator: { result: OrderBlockBarResult[] }
    crosshair: { dataIndex?: number }
  }) => {
    const row = indicator.result[crosshair.dataIndex ?? indicator.result.length - 1]
    return {
      calcParamsText: '',
      values: [
        row?.bullOB ? { title: '买单块: ', value: { text: formatPrice(row.bullOB), color: '#22c55e' } } : null,
        row?.bearOB ? { title: '卖单块: ', value: { text: formatPrice(row.bearOB), color: '#ef4444' } } : null,
        row?.breaker ? { title: '破坏块: ', value: { text: formatPrice(row.breaker), color: '#a855f7' } } : null,
      ].filter((x): x is NonNullable<typeof x> => x !== null),
      icons: [],
    }
  },
  draw: ({ ctx, indicator, xAxis, yAxis, bounding }: {
    ctx: CanvasRenderingContext2D
    indicator: { result: OrderBlockBarResult[] }
    xAxis: { convertToPixel: (val: number) => number }
    yAxis: { convertToPixel: (val: number) => number }
    bounding: { width: number; height: number }
  }) => {
    const results = indicator.result
    if (!results || results.length === 0) return false
    const lastResult = results[results.length - 1]
    if (!lastResult || !lastResult.activeZones || lastResult.activeZones.length === 0) return false

    ctx.save()
    for (const zone of lastResult.activeZones) {
      const x1 = Math.max(0, xAxis.convertToPixel(zone.left))
      const x2 = bounding.width
      if (x1 >= x2) continue
      const yTop = yAxis.convertToPixel(zone.top)
      const yBot = yAxis.convertToPixel(zone.bot)
      const yMin = Math.min(yTop, yBot)
      const boxHeight = Math.max(2, Math.abs(yBot - yTop))

      let fillColor = 'rgba(34, 197, 94, 0.15)'
      let borderColor = '#22c55e'
      let labelText = zhZoneTag(zone.tag)

      if (zone.state === 'mitigated') {
        fillColor = 'rgba(156, 163, 175, 0.12)'
        borderColor = '#9ca3af'
        labelText += '（已回补）'
      } else if (zone.state === 'breaker') {
        if (zone.polarity === 'bullish') {
          fillColor = 'rgba(34, 197, 94, 0.2)'
          borderColor = '#22c55e'
        } else {
          fillColor = 'rgba(239, 68, 68, 0.2)'
          borderColor = '#ef4444'
        }
      } else {
        if (zone.polarity === 'bearish') {
          fillColor = 'rgba(239, 68, 68, 0.15)'
          borderColor = '#ef4444'
        }
      }

      ctx.fillStyle = fillColor
      ctx.fillRect(x1, yMin, x2 - x1, boxHeight)

      ctx.strokeStyle = borderColor
      ctx.lineWidth = 1
      ctx.setLineDash([])
      ctx.strokeRect(x1, yMin, x2 - x1, boxHeight)

      ctx.font = '10px sans-serif'
      ctx.fillStyle = borderColor
      ctx.fillText(labelText, x1 + 4, yMin + 12)
    }
    ctx.restore()
    return false
  },
}
