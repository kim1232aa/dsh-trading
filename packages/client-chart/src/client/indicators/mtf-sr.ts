/**
 * Intraday MTF S/R Zones [ProjectSyndicate] (TradingView Pine Script v6 port).
 * Builds multi-timeframe swing pivot support & resistance with confluence merging
 * and conviction scoring (0-10).
 */

export interface Candle {
  open?: number
  high: number
  low: number
  close: number
  volume?: number
  timestamp?: number
  time?: number
}

export type ZoneTier = 'ELITE' | 'STRONG' | 'MODERATE' | 'WEAK' | 'FORMING'

export interface SRZone {
  id: string
  isRes: boolean
  level: number
  top: number
  bottom: number
  score: number
  tier: ZoneTier
  stars: string
  timeframes: string[]
  confluenceCount: number
  tfWeight: number
  wickAvg: number
  wickSum: number
  wickN: number
  prominence: number
  sessionId: number
  startBar: number
  endBar?: number
}

export interface MtfSRBarPoint {
  res?: number | undefined
  resTop?: number | undefined
  resBottom?: number | undefined
  sup?: number | undefined
  supTop?: number | undefined
  supBottom?: number | undefined
  confluence?: number | undefined
  confTop?: number | undefined
  confBottom?: number | undefined
  atr?: number | undefined
}

export interface ScoringWeights {
  tf: number
  confluence: number
  wick: number
  prominence: number
}

export interface MtfSROptions {
  pivotLeft?: number
  pivotRight?: number
  enableResistance?: boolean
  enableSupport?: boolean
  timeframes?: (string | number)[]
  simulatedBuckets?: number[]
  atrPeriod?: number
  thicknessMode?: 'ATR ×' | '% of Price'
  thicknessAtr?: number
  thicknessPct?: number
  mergeEnabled?: boolean
  mergeAtrMultiple?: number
  confluenceBonus?: number
  weights?: Partial<ScoringWeights>
  minScore?: number
  strongThreshold?: number
  sessionTimeframe?: string
  sessionsToKeep?: number
  maxZonesPerSession?: number
}

export interface MtfSRDashboard {
  strongest?: SRZone | undefined
  nearestRes?: SRZone | undefined
  nearestSup?: SRZone | undefined
  pricePosition: 'Near SUP' | 'Near RES' | '—'
  roomAtr?: number | undefined
  activeCount: number
  confluenceCount: number
  avgScore?: number | undefined
  tfBreakdown: Record<string, { res: number; sup: number; bias: string }>
}

export interface MtfSRResult {
  resistance: SRZone[]
  support: SRZone[]
  confluence: SRZone[]
  allZones: SRZone[]
  resistanceLevels: number[]
  supportLevels: number[]
  confluenceLevels: number[]
  series: MtfSRBarPoint[]
  dashboard: MtfSRDashboard
}

/* ------------------------------------------------------------------ */
/* Math & Scoring Helpers                                             */
/* ------------------------------------------------------------------ */

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function parseTimeframeSeconds(tf: string | number): number {
  if (typeof tf === 'number') return tf >= 60 ? tf : tf * 60
  const s = tf.trim().toUpperCase()
  if (s === 'D' || s === '1D') return 86400
  if (s === 'W' || s === '1W') return 604800
  if (s === 'M' || s === '1M') return 2592000
  if (s.endsWith('D')) return (parseFloat(s) || 1) * 86400
  if (s.endsWith('H')) return (parseFloat(s) || 1) * 3600
  if (s.endsWith('M')) return (parseFloat(s) || 1) * 60
  if (s.endsWith('S')) return parseFloat(s) || 1
  const num = parseFloat(s)
  return Number.isNaN(num) ? 1800 : num * 60
}

export function getTimeframeLabel(sec: number): string {
  if (sec % 86400 === 0) return `D${sec / 86400}`
  if (sec >= 3600 && sec % 3600 === 0) return `H${sec / 3600}`
  if (sec >= 60) return `M${Math.round(sec / 60)}`
  return `S${sec}`
}

export function getTimeframeWeight(sec: number): number {
  if (sec >= 14400) return 1.0
  if (sec >= 3600) return 0.78
  if (sec >= 900) return 0.55
  if (sec >= 300) return 0.38
  if (sec >= 60) return 0.30
  return 0.25
}

export function getStars(s: number): string {
  if (s >= 8.0) return '★★★★★'
  if (s >= 6.5) return '★★★★'
  if (s >= 5.0) return '★★★'
  if (s >= 3.5) return '★★'
  if (s >= 2.0) return '★'
  return '·'
}

export function getTier(s: number): ZoneTier {
  if (s >= 8.0) return 'ELITE'
  if (s >= 6.5) return 'STRONG'
  if (s >= 5.0) return 'MODERATE'
  if (s >= 3.5) return 'WEAK'
  return 'FORMING'
}

export function calculateStrengthScore(
  tfWeight: number,
  confluenceCount: number,
  wickAvg: number,
  prominence: number,
  atr: number,
  weights: Partial<ScoringWeights> = {},
  confluenceBonus = 0.9,
): number {
  const wTF = weights.tf ?? 0.40
  const wConf = weights.confluence ?? 0.28
  const wWick = weights.wick ?? 0.18
  const wPro = weights.prominence ?? 0.14

  const tfF = clamp(tfWeight, 0.0, 1.0)
  const cnfF = clamp((confluenceCount - 1) / 2.0, 0.0, 1.0)
  const wkF = atr > 0 ? clamp(wickAvg / (atr * 0.6), 0.0, 1.0) : 0.0
  const prF = atr > 0 ? clamp(prominence / (atr * 3.0), 0.0, 1.0) : 0.0

  const wSum = Math.max(wTF + wConf + wWick + wPro, 1e-6)
  const raw = (tfF * wTF + cnfF * wConf + wkF * wWick + prF * wPro) / wSum
  const score = raw * 10.0 + confluenceBonus * (confluenceCount - 1)
  return clamp(score, 0.0, 10.0)
}

export function calculateATR(
  bars: readonly { high: number; low: number; close: number }[],
  period = 14,
): number[] {
  const n = bars.length
  if (n === 0) return []
  const tr = new Array<number>(n)
  const first = bars[0]!
  tr[0] = first.high - first.low
  for (let i = 1; i < n; i++) {
    const cur = bars[i]!
    const prevC = bars[i - 1]!.close
    tr[i] = Math.max(cur.high - cur.low, Math.abs(cur.high - prevC), Math.abs(cur.low - prevC))
  }
  const atr = new Array<number>(n)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const tVal = tr[i]!
    if (i < period) {
      sum += tVal
      atr[i] = sum / (i + 1)
    } else {
      const prevAtr = atr[i - 1]!
      atr[i] = (prevAtr * (period - 1) + tVal) / period
    }
  }
  return atr
}

/* ------------------------------------------------------------------ */
/* Pivot Detection Core                                               */
/* ------------------------------------------------------------------ */

interface HTFCandle {
  open: number
  high: number
  low: number
  close: number
  hl2: number
  timestamp: number
  endBaseBarIndex: number
}

interface PivotEvent {
  isRes: boolean
  level: number
  wick: number
  prominence: number
  baseBarIndex: number
  tfSlotId: string
  tfLabel: string
  sec: number
  tfWeight: number
}

function computePivotsForHTF(
  htfBars: HTFCandle[],
  pL: number,
  pR: number,
  atrPeriod: number,
  tfSlotId: string,
  tfLabel: string,
  sec: number,
  tfWeight: number,
  enableRes: boolean,
  enableSup: boolean,
): PivotEvent[] {
  const n = htfBars.length
  if (n < pL + pR + 1) return []

  const lenRef = pL + pR

  // Compute SMA of hl2 over lenRef
  const smaHl2 = new Array<number>(n)
  let windowSum = 0
  for (let i = 0; i < n; i++) {
    windowSum += htfBars[i]!.hl2
    if (i >= lenRef) {
      windowSum -= htfBars[i - lenRef]!.hl2
      smaHl2[i] = windowSum / lenRef
    } else {
      smaHl2[i] = windowSum / (i + 1)
    }
  }

  const events: PivotEvent[] = []

  for (let k = pL + pR; k < n; k++) {
    const pIdx = k - pR
    const pBar = htfBars[pIdx]!
    const confBaseIdx = htfBars[k]!.endBaseBarIndex

    if (enableRes) {
      let isHigh = true
      for (let j = pIdx - pL; j < pIdx; j++) {
        if (htfBars[j]!.high > pBar.high) {
          isHigh = false
          break
        }
      }
      if (isHigh) {
        for (let j = pIdx + 1; j <= pIdx + pR; j++) {
          if (htfBars[j]!.high >= pBar.high) {
            isHigh = false
            break
          }
        }
      }
      if (isHigh) {
        const wick = Math.max(pBar.high - Math.max(pBar.open, pBar.close), 0)
        const prom = Math.max(pBar.high - (smaHl2[k] ?? pBar.high), 0)
        events.push({
          isRes: true,
          level: pBar.high,
          wick,
          prominence: prom,
          baseBarIndex: confBaseIdx,
          tfSlotId,
          tfLabel,
          sec,
          tfWeight,
        })
      }
    }

    if (enableSup) {
      let isLow = true
      for (let j = pIdx - pL; j < pIdx; j++) {
        if (htfBars[j]!.low < pBar.low) {
          isLow = false
          break
        }
      }
      if (isLow) {
        for (let j = pIdx + 1; j <= pIdx + pR; j++) {
          if (htfBars[j]!.low <= pBar.low) {
            isLow = false
            break
          }
        }
      }
      if (isLow) {
        const wick = Math.max(Math.min(pBar.open, pBar.close) - pBar.low, 0)
        const prom = Math.max((smaHl2[k] ?? pBar.low) - pBar.low, 0)
        events.push({
          isRes: false,
          level: pBar.low,
          wick,
          prominence: prom,
          baseBarIndex: confBaseIdx,
          tfSlotId,
          tfLabel,
          sec,
          tfWeight,
        })
      }
    }
  }

  return events
}

/* ------------------------------------------------------------------ */
/* Resampling & Simulated Bucketing                                   */
/* ------------------------------------------------------------------ */

function resampleCandles(
  candles: readonly Candle[],
  slotSec: number,
  bucketMultiplier?: number,
): HTFCandle[] {
  const n = candles.length
  if (n === 0) return []

  const result: HTFCandle[] = []

  // Case A: explicit bucket multiplier (simulated MTF)
  if (bucketMultiplier && bucketMultiplier > 0) {
    const bSize = Math.max(1, Math.round(bucketMultiplier))
    for (let i = 0; i < n; i += bSize) {
      const chunkEnd = Math.min(i + bSize, n)
      const firstBar = candles[i]!
      const lastBar = candles[chunkEnd - 1]!
      const o = firstBar.open ?? firstBar.close
      let h = -Infinity
      let l = Infinity
      const c = lastBar.close
      for (let j = i; j < chunkEnd; j++) {
        const bar = candles[j]!
        if (bar.high > h) h = bar.high
        if (bar.low < l) l = bar.low
      }
      const t = firstBar.timestamp ?? firstBar.time ?? i * 300_000
      result.push({
        open: o,
        high: h,
        low: l,
        close: c,
        hl2: (h + l) / 2,
        timestamp: t,
        endBaseBarIndex: chunkEnd - 1,
      })
    }
    return result
  }

  // Case B: timestamp-based bucketing
  const firstCandle = candles[0]!
  const hasTimestamps = firstCandle.timestamp !== undefined || firstCandle.time !== undefined
  const slotMs = slotSec * 1000

  if (hasTimestamps) {
    let currentBucket: HTFCandle | null = null
    let currentBucketKey = -1

    for (let i = 0; i < n; i++) {
      const bar = candles[i]!
      const t = (bar.timestamp ?? bar.time)!
      const bucketKey = Math.floor(t / slotMs)

      if (bucketKey !== currentBucketKey) {
        if (currentBucket) {
          result.push(currentBucket)
        }
        currentBucketKey = bucketKey
        const o = bar.open ?? bar.close
        currentBucket = {
          open: o,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          hl2: (bar.high + bar.low) / 2,
          timestamp: bucketKey * slotMs,
          endBaseBarIndex: i,
        }
      } else if (currentBucket) {
        if (bar.high > currentBucket.high) currentBucket.high = bar.high
        if (bar.low < currentBucket.low) currentBucket.low = bar.low
        currentBucket.close = bar.close
        currentBucket.hl2 = (currentBucket.high + currentBucket.low) / 2
        currentBucket.endBaseBarIndex = i
      }
    }
    if (currentBucket) {
      result.push(currentBucket)
    }
    return result
  }

  // Case C: simulated default fallback using 5m synthesized timestamps
  const synthesizedBaseStep = 300_000 // 5 minutes in ms
  const barsPerSlot = Math.max(1, Math.round(slotMs / synthesizedBaseStep))
  return resampleCandles(candles, slotSec, barsPerSlot)
}

/* ------------------------------------------------------------------ */
/* Zone Thickness & Confluence Consolidation                          */
/* ------------------------------------------------------------------ */

function computeThickness(
  mode: 'ATR ×' | '% of Price',
  thAtr: number,
  thPct: number,
  atr: number,
  close: number,
): number {
  return mode === 'ATR ×' ? Math.max(atr * thAtr, 1e-6) : Math.max(close * (thPct / 100), 1e-6)
}

function absorbZone(
  a: SRZone,
  b: SRZone,
  atrChart: number,
  close: number,
  weights: Partial<ScoringWeights>,
  confBonus: number,
  thMode: 'ATR ×' | '% of Price',
  thAtr: number,
  thPct: number,
): void {
  const tfSet = new Set([...a.timeframes, ...b.timeframes])
  a.timeframes = Array.from(tfSet)
  const cc = a.timeframes.length
  a.confluenceCount = cc

  const wkA = Math.max(a.wickN, 1)
  const wkB = Math.max(b.wickN, 1)
  a.level = (a.level * wkA + b.level * wkB) / (wkA + wkB)
  a.wickSum += b.wickSum
  a.wickN += b.wickN
  a.prominence = Math.max(a.prominence, b.prominence)
  a.tfWeight = Math.max(a.tfWeight, b.tfWeight)

  const h = computeThickness(thMode, thAtr, thPct, atrChart, close)
  a.top = a.level + h / 2.0
  a.bottom = a.level - h / 2.0

  const wickAvg = a.wickSum / Math.max(a.wickN, 1)
  a.wickAvg = wickAvg
  a.score = calculateStrengthScore(a.tfWeight, cc, wickAvg, a.prominence, atrChart, weights, confBonus)
  a.tier = getTier(a.score)
  a.stars = getStars(a.score)
}

function consolidateZones(
  zones: SRZone[],
  sessionId: number,
  atrChart: number,
  close: number,
  mergeAtrMultiple: number,
  weights: Partial<ScoringWeights>,
  confBonus: number,
  thMode: 'ATR ×' | '% of Price',
  thAtr: number,
  thPct: number,
): boolean {
  let didAnyMerge = false
  let guard = 0
  const tol = atrChart * mergeAtrMultiple

  while (guard < 40) {
    let mergedInPass = false
    const n = zones.length
    for (let i = 0; i < n - 1; i++) {
      if (mergedInPass) break
      for (let j = i + 1; j < n; j++) {
        const A = zones[i]
        const B = zones[j]
        if (A && B && A.sessionId === sessionId && B.sessionId === sessionId && A.isRes === B.isRes) {
          if (A.bottom <= B.top + tol && B.bottom <= A.top + tol) {
            absorbZone(A, B, atrChart, close, weights, confBonus, thMode, thAtr, thPct)
            zones.splice(j, 1)
            mergedInPass = true
            didAnyMerge = true
            break
          }
        }
      }
    }
    if (!mergedInPass) break
    guard++
  }

  return didAnyMerge
}

function capSessionZones(zones: SRZone[], sessionId: number, cap: number): void {
  let count = zones.filter(z => z.sessionId === sessionId).length
  let guard = 0
  while (count > cap && guard < 60) {
    let worstIdx = -1
    let lowestScore = Infinity
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i]
      if (z && z.sessionId === sessionId && z.score < lowestScore) {
        lowestScore = z.score
        worstIdx = i
      }
    }
    if (worstIdx < 0) break
    zones.splice(worstIdx, 1)
    count--
    guard++
  }
}

function pruneOldSessions(zones: SRZone[], currentSessionId: number, keepN: number): void {
  for (let i = zones.length - 1; i >= 0; i--) {
    const z = zones[i]
    if (z && z.sessionId <= currentSessionId - keepN) {
      zones.splice(i, 1)
    }
  }
}

/* ------------------------------------------------------------------ */
/* Main Indicator Calculation                                         */
/* ------------------------------------------------------------------ */

export function calculateMtfSR(
  candles: readonly Candle[],
  options: MtfSROptions = {},
): MtfSRResult {
  const n = candles.length
  if (n === 0) {
    return {
      resistance: [],
      support: [],
      confluence: [],
      allZones: [],
      resistanceLevels: [],
      supportLevels: [],
      confluenceLevels: [],
      series: [],
      dashboard: {
        pricePosition: '—',
        activeCount: 0,
        confluenceCount: 0,
        tfBreakdown: {},
      },
    }
  }

  const pL = options.pivotLeft ?? 5
  const pR = options.pivotRight ?? 5
  const enableRes = options.enableResistance ?? true
  const enableSup = options.enableSupport ?? true
  const atrPeriod = options.atrPeriod ?? 14
  const thMode = options.thicknessMode ?? 'ATR ×'
  const thAtr = options.thicknessAtr ?? 0.28
  const thPct = options.thicknessPct ?? 0.10
  const mergeEnabled = options.mergeEnabled ?? true
  const mergeAtr = options.mergeAtrMultiple ?? 0.35
  const confBonus = options.confluenceBonus ?? 0.9
  const weights = options.weights ?? { tf: 0.40, confluence: 0.28, wick: 0.18, prominence: 0.14 }
  const minScore = options.minScore ?? 0.0
  const keepSessions = options.sessionsToKeep ?? 3
  const capSession = options.maxZonesPerSession ?? 14

  // Timeframe slots configuration
  const defaultTfs: (string | number)[] = ['30', '60', '120', '240']
  const tfInputs = options.timeframes ?? defaultTfs
  const simBuckets = options.simulatedBuckets

  // ponytail: MTF slots capped to 8 concurrent streams; add dynamic router when tick streaming requires >8.
  const slots = tfInputs.map((tf, idx) => {
    const sec = parseTimeframeSeconds(tf)
    const label = getTimeframeLabel(sec)
    const weight = getTimeframeWeight(sec)
    const bucket = simBuckets && simBuckets[idx] !== undefined ? simBuckets[idx] : undefined
    return { id: String(tf), label, sec, weight, bucket }
  })

  // Pre-calculate base ATR
  const baseATR = calculateATR(candles, atrPeriod)

  // Collect all confirmed pivot events from all MTF slots
  const allEventsByBaseBar = new Map<number, PivotEvent[]>()
  for (const slot of slots) {
    const htfBars = resampleCandles(candles, slot.sec, slot.bucket)
    const events = computePivotsForHTF(
      htfBars,
      pL,
      pR,
      atrPeriod,
      slot.id,
      slot.label,
      slot.sec,
      slot.weight,
      enableRes,
      enableSup,
    )
    for (const ev of events) {
      let list = allEventsByBaseBar.get(ev.baseBarIndex)
      if (!list) {
        list = []
        allEventsByBaseBar.set(ev.baseBarIndex, list)
      }
      list.push(ev)
    }
  }

  // Session detection setup (Pine default "D")
  const sessionSec = parseTimeframeSeconds(options.sessionTimeframe ?? 'D')
  const sessionMs = sessionSec * 1000

  const zones: SRZone[] = []
  const series: MtfSRBarPoint[] = new Array(n)
  let currentSessionId = 0
  let prevSessionKey = -1
  let zoneSeq = 0

  // Track last spawned levels per slot to prevent duplicate continuous spawns
  const lastSpawnedPh = new Map<string, number>()
  const lastSpawnedPl = new Map<string, number>()

  for (let i = 0; i < n; i++) {
    const bar = candles[i]!
    const curClose = bar.close
    const curAtr = baseATR[i] || 1e-6
    const t = bar.timestamp ?? bar.time ?? i * 300_000

    // Session boundary check
    const sessionKey = Math.floor(t / sessionMs)
    if (i === 0) {
      prevSessionKey = sessionKey
    } else if (sessionKey !== prevSessionKey) {
      currentSessionId++
      prevSessionKey = sessionKey
      pruneOldSessions(zones, currentSessionId, keepSessions)
      lastSpawnedPh.clear()
      lastSpawnedPl.clear()
    }

    // Process pivot events confirmed at this base bar
    const barEvents = allEventsByBaseBar.get(i)
    let spawned = false

    if (barEvents && barEvents.length > 0) {
      for (const ev of barEvents) {
        const lastLvl = ev.isRes ? lastSpawnedPh.get(ev.tfSlotId) : lastSpawnedPl.get(ev.tfSlotId)
        if (lastLvl === undefined || Math.abs(lastLvl - ev.level) > 1e-9) {
          if (ev.isRes) lastSpawnedPh.set(ev.tfSlotId, ev.level)
          else lastSpawnedPl.set(ev.tfSlotId, ev.level)

          const h = computeThickness(thMode, thAtr, thPct, curAtr, curClose)
          const sc = calculateStrengthScore(ev.tfWeight, 1, ev.wick, ev.prominence, curAtr, weights, confBonus)
          const zoneId = `z-${++zoneSeq}`

          zones.push({
            id: zoneId,
            isRes: ev.isRes,
            level: ev.level,
            top: ev.level + h / 2.0,
            bottom: ev.level - h / 2.0,
            score: sc,
            tier: getTier(sc),
            stars: getStars(sc),
            timeframes: [ev.tfLabel],
            confluenceCount: 1,
            tfWeight: ev.tfWeight,
            wickAvg: ev.wick,
            wickSum: ev.wick,
            wickN: ev.wick > 0 ? 1 : 0,
            prominence: ev.prominence,
            sessionId: currentSessionId,
            startBar: i,
          })
          spawned = true
        }
      }

      if (spawned && mergeEnabled) {
        consolidateZones(zones, currentSessionId, curAtr, curClose, mergeAtr, weights, confBonus, thMode, thAtr, thPct)
      }
      if (spawned) {
        capSessionZones(zones, currentSessionId, capSession)
      }
    }

    // Determine nearest levels for the series output at bar i
    const activeAtBar = zones.filter(z => z.score >= minScore)
    let nearestResZone: SRZone | undefined
    let minResDist = Infinity
    let nearestSupZone: SRZone | undefined
    let minSupDist = Infinity
    let nearestConfZone: SRZone | undefined
    let minConfDist = Infinity

    for (const z of activeAtBar) {
      if (z.isRes) {
        const dist = z.level >= curClose ? z.level - curClose : (curClose - z.level) * 2
        if (dist < minResDist) {
          minResDist = dist
          nearestResZone = z
        }
      } else {
        const dist = z.level <= curClose ? curClose - z.level : (z.level - curClose) * 2
        if (dist < minSupDist) {
          minSupDist = dist
          nearestSupZone = z
        }
      }

      if (z.confluenceCount > 1) {
        const dist = Math.abs(z.level - curClose)
        if (dist < minConfDist) {
          minConfDist = dist
          nearestConfZone = z
        }
      }
    }

    series[i] = {
      res: nearestResZone?.level,
      resTop: nearestResZone?.top,
      resBottom: nearestResZone?.bottom,
      sup: nearestSupZone?.level,
      supTop: nearestSupZone?.top,
      supBottom: nearestSupZone?.bottom,
      confluence: nearestConfZone?.level,
      confTop: nearestConfZone?.top,
      confBottom: nearestConfZone?.bottom,
      atr: baseATR[i],
    }
  }

  // Final summary snapshot
  const finalActive = zones.filter(z => z.score >= minScore)
  const finalResistance = finalActive.filter(z => z.isRes)
  const finalSupport = finalActive.filter(z => !z.isRes)
  const finalConfluence = finalActive.filter(z => z.confluenceCount > 1)

  const lastBar = candles[n - 1]!
  const lastClose = lastBar.close
  const lastAtr = baseATR[n - 1] || 1e-6

  // Find nearest resistance above and nearest support below price
  let nearestResZone: SRZone | undefined
  let minResGap = Infinity
  for (const z of finalResistance) {
    if (z.level >= lastClose && z.level - lastClose < minResGap) {
      minResGap = z.level - lastClose
      nearestResZone = z
    }
  }
  if (!nearestResZone && finalResistance.length > 0) {
    nearestResZone = finalResistance[0]
  }

  let nearestSupZone: SRZone | undefined
  let minSupGap = Infinity
  for (const z of finalSupport) {
    if (z.level <= lastClose && lastClose - z.level < minSupGap) {
      minSupGap = lastClose - z.level
      nearestSupZone = z
    }
  }
  if (!nearestSupZone && finalSupport.length > 0) {
    nearestSupZone = finalSupport[0]
  }

  // Find strongest zone overall
  let strongestZone: SRZone | undefined
  let maxScore = -1
  for (const z of finalActive) {
    if (z.score > maxScore) {
      maxScore = z.score
      strongestZone = z
    }
  }

  // Dashboard structure & breakdown
  const tfBreakdown: Record<string, { res: number; sup: number; bias: string }> = {}
  for (const s of slots) {
    const resCount = finalResistance.filter(z => z.timeframes.includes(s.label)).length
    const supCount = finalSupport.filter(z => z.timeframes.includes(s.label)).length
    const bias = resCount + supCount === 0 ? '—' : resCount > supCount ? '▲ RES' : supCount > resCount ? '▼ SUP' : '● BAL'
    tfBreakdown[s.label] = { res: resCount, sup: supCount, bias }
  }

  let pricePos: 'Near SUP' | 'Near RES' | '—' = '—'
  let roomAtr: number | undefined
  if (nearestResZone && nearestSupZone) {
    const distSup = lastClose - nearestSupZone.level
    const distRes = nearestResZone.level - lastClose
    pricePos = distSup < distRes ? 'Near SUP' : 'Near RES'
    roomAtr = (nearestResZone.level - nearestSupZone.level) / Math.max(lastAtr, 1e-9)
  }

  const scoreSum = finalActive.reduce((acc, z) => acc + z.score, 0)
  const avgScore = finalActive.length > 0 ? scoreSum / finalActive.length : undefined

  return {
    resistance: finalResistance,
    support: finalSupport,
    confluence: finalConfluence,
    allZones: finalActive,
    resistanceLevels: finalResistance.map(z => z.level),
    supportLevels: finalSupport.map(z => z.level),
    confluenceLevels: finalConfluence.map(z => z.level),
    series,
    dashboard: {
      strongest: strongestZone,
      nearestRes: nearestResZone,
      nearestSup: nearestSupZone,
      pricePosition: pricePos,
      roomAtr,
      activeCount: finalActive.length,
      confluenceCount: finalConfluence.length,
      avgScore,
      tfBreakdown,
    },
  }
}

/* ------------------------------------------------------------------ */
/* Backward Compatibility & Klinecharts Definition                    */
/* ------------------------------------------------------------------ */

/**
 * Backward-compatible wrapper matching the legacy chart registration.
 */
export function mtfSRZones(
  bars: readonly Candle[],
  pivotPeriod = 5,
): MtfSRBarPoint[] {
  const result = calculateMtfSR(bars, {
    pivotLeft: pivotPeriod,
    pivotRight: pivotPeriod,
  })
  return result.series
}

/**
 * Klinecharts registration configuration for MTF S/R Zones.
 */
export const mtfSRIndicator = {
  name: 'MTF_SR',
  shortName: '多周期支阻',
  series: 'price' as const,
  precision: 2,
  calcParams: [5, 5, 0.35],
  figures: [
    { key: 'res', type: 'line' as const },
    { key: 'sup', type: 'line' as const },
    { key: 'confluence', type: 'line' as const },
  ],
  styles: {
    lines: [
      { color: '#158362', size: 2, style: 'solid', smooth: false, dashedValue: [2, 2] },
      { color: '#851793', size: 2, style: 'solid', smooth: false, dashedValue: [2, 2] },
      { color: '#7458a6', size: 2, style: 'dashed', smooth: false, dashedValue: [3, 3] },
    ],
  },
  calc: (dataList: Candle[], ind?: { calcParams?: number[] }): MtfSRBarPoint[] => {
    const pL = ind?.calcParams?.[0] ?? 5
    const pR = ind?.calcParams?.[1] ?? pL
    const mergeAtr = ind?.calcParams?.[2] ?? 0.35
    const res = calculateMtfSR(dataList, {
      pivotLeft: pL,
      pivotRight: pR,
      mergeAtrMultiple: mergeAtr,
    })
    return res.series
  },
  createTooltipDataSource: ({ indicator, crosshair }: {
    indicator: { calcParams?: number[]; result?: MtfSRBarPoint[] }
    crosshair: { dataIndex?: number }
  }) => {
    const row = crosshair.dataIndex !== undefined ? indicator.result?.[crosshair.dataIndex] : undefined
    return {
      calcParamsText: '',
      values: [
        row?.res ? {
          title: '阻力: ',
          value: {
            text: row.resTop && row.resBottom
              ? `${row.res.toFixed(2)} [${row.resBottom.toFixed(2)}~${row.resTop.toFixed(2)}]`
              : row.res.toFixed(2),
            color: '#158362',
          },
        } : null,
        row?.sup ? {
          title: '支撑: ',
          value: {
            text: row.supTop && row.supBottom
              ? `${row.sup.toFixed(2)} [${row.supBottom.toFixed(2)}~${row.supTop.toFixed(2)}]`
              : row.sup.toFixed(2),
            color: '#851793',
          },
        } : null,
        row?.confluence ? {
          title: '共振带: ',
          value: { text: row.confluence.toFixed(2), color: '#7458a6' },
        } : null,
      ].filter((x): x is NonNullable<typeof x> => x !== null),
    }
  },
  draw: ({ ctx, indicator, xAxis, yAxis, visibleRange }: {
    ctx: CanvasRenderingContext2D
    indicator: { result: MtfSRBarPoint[] }
    xAxis: { convertToPixel: (val: number) => number }
    yAxis: { convertToPixel: (val: number) => number }
    visibleRange: { from: number; to: number }
  }) => {
    const results = indicator.result
    if (!results || results.length === 0) return false
    const from = Math.max(0, visibleRange.from)
    const to = Math.min(results.length - 1, visibleRange.to)
    if (from >= to) return false

    ctx.save()

    // 1. Draw dynamic ATR channel bands for Resistance and Support zones
    for (let i = from + 1; i <= to; i++) {
      const prev = results[i - 1]
      const curr = results[i]
      if (!prev || !curr) continue

      const x0 = xAxis.convertToPixel(i - 1)
      const x1 = xAxis.convertToPixel(i)

      // Draw Resistance ATR channel zone (translucent emerald fill with dashed borders)
      if (
        curr.resTop !== undefined && curr.resBottom !== undefined &&
        prev.resTop !== undefined && prev.resBottom !== undefined &&
        Math.abs(curr.resTop - prev.resTop) < (curr.atr ?? 10) * 3
      ) {
        const yTop0 = yAxis.convertToPixel(prev.resTop)
        const yBot0 = yAxis.convertToPixel(prev.resBottom)
        const yTop1 = yAxis.convertToPixel(curr.resTop)
        const yBot1 = yAxis.convertToPixel(curr.resBottom)

        ctx.beginPath()
        ctx.moveTo(x0, yTop0)
        ctx.lineTo(x1, yTop1)
        ctx.lineTo(x1, yBot1)
        ctx.lineTo(x0, yBot0)
        ctx.closePath()
        ctx.fillStyle = 'rgba(21, 131, 98, 0.12)'
        ctx.fill()

        // Border dashed lines
        ctx.strokeStyle = 'rgba(21, 131, 98, 0.35)'
        ctx.lineWidth = 1
        ctx.setLineDash([2, 2])
        ctx.beginPath()
        ctx.moveTo(x0, yTop0)
        ctx.lineTo(x1, yTop1)
        ctx.moveTo(x0, yBot0)
        ctx.lineTo(x1, yBot1)
        ctx.stroke()
      }

      // Draw Support ATR channel zone (translucent purple fill with dashed borders)
      if (
        curr.supTop !== undefined && curr.supBottom !== undefined &&
        prev.supTop !== undefined && prev.supBottom !== undefined &&
        Math.abs(curr.supTop - prev.supTop) < (curr.atr ?? 10) * 3
      ) {
        const yTop0 = yAxis.convertToPixel(prev.supTop)
        const yBot0 = yAxis.convertToPixel(prev.supBottom)
        const yTop1 = yAxis.convertToPixel(curr.supTop)
        const yBot1 = yAxis.convertToPixel(curr.supBottom)

        ctx.beginPath()
        ctx.moveTo(x0, yTop0)
        ctx.lineTo(x1, yTop1)
        ctx.lineTo(x1, yBot1)
        ctx.lineTo(x0, yBot0)
        ctx.closePath()
        ctx.fillStyle = 'rgba(133, 23, 147, 0.12)'
        ctx.fill()

        // Border dashed lines
        ctx.strokeStyle = 'rgba(133, 23, 147, 0.35)'
        ctx.lineWidth = 1
        ctx.setLineDash([2, 2])
        ctx.beginPath()
        ctx.moveTo(x0, yTop0)
        ctx.lineTo(x1, yTop1)
        ctx.moveTo(x0, yBot0)
        ctx.lineTo(x1, yBot1)
        ctx.stroke()
      }
    }

    ctx.restore()
    return false
  },
}
