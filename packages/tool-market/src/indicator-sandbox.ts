/**
 * Sandboxed custom indicator execution engine with strict timeout and isolation.
 * Inspired by @dshtrading/indicators custom sandbox.
 * @module @dsh-trading/tool-market
 */

import { createContext, runInContext } from 'node:vm'
import type { Candle } from '@dsh-trading/market-data'
import { ema, macd, stochastic, bollinger, atr, adx, mfi } from './candle-indicators.js'
import { rsi, sma, wma } from './indicators.js'

export interface CustomIndicatorOptions {
  timeoutMs?: number
  name?: string
}

export interface CustomIndicatorResult {
  name: string
  values: (number | null)[]
  executionTimeMs: number
}

/** One confirmed pivot. */
export interface SwingPoint { index: number; price: number; time: string }

/**
 * Detect swing high/low pivot points (Williams-fractal style, generalised).
 *
 * A swing high at index i means highs[i] >  highs[j] for every j in [i-left, i+right], j≠i.
 * A swing low  at index i means  lows[i] <   lows[j] for every j in [i-left, i+right], j≠i.
 * Strict comparison (as TA-Lib FRACTAL / ta4j) so flat stretches don't spray duplicate pivots.
 * The last `right` bars can never be confirmed — a pivot needs its right arm closed.
 */
export function detectSwingPoints(
  candles: readonly Candle[],
  left = 3,
  right = 3,
): { swingHighs: SwingPoint[]; swingLows: SwingPoint[] } {
  const swingHighs: SwingPoint[] = []
  const swingLows: SwingPoint[] = []
  const l = Math.max(1, Math.floor(left))
  const r = Math.max(1, Math.floor(right))
  for (let i = l; i < candles.length - r; i++) {
    let isHigh = true
    let isLow = true
    for (let j = i - l; j <= i + r; j++) {
      if (j === i) continue
      if (candles[j]!.high >= candles[i]!.high) isHigh = false
      if (candles[j]!.low <= candles[i]!.low) isLow = false
      if (!isHigh && !isLow) break
    }
    if (isHigh) swingHighs.push({ index: i, price: candles[i]!.high, time: candles[i]!.time })
    if (isLow) swingLows.push({ index: i, price: candles[i]!.low, time: candles[i]!.time })
  }
  return { swingHighs, swingLows }
}

export type SwingLabel = 'HH' | 'LH' | 'EH' | 'HL' | 'LL' | 'EL' | 'H' | 'L'

export interface LabelledSwing extends SwingPoint { kind: 'high' | 'low'; label: SwingLabel }

/**
 * Label each pivot against the previous pivot of the same kind (HH/LH for highs,
 * HL/LL for lows; first of each kind is plain H/L) and read the structure bias
 * from the latest high + latest low: HH+HL = up, LH+LL = down, otherwise range.
 */
export function classifySwingStructure(
  swings: { swingHighs: readonly SwingPoint[]; swingLows: readonly SwingPoint[] },
): { points: LabelledSwing[]; bias: 'up' | 'down' | 'range' } {
  const label = (list: readonly SwingPoint[], kind: 'high' | 'low'): LabelledSwing[] =>
    list.map((p, k) => {
      const prev = list[k - 1]
      let lab: SwingLabel
      if (prev === undefined) lab = kind === 'high' ? 'H' : 'L'
      else if (p.price > prev.price) lab = kind === 'high' ? 'HH' : 'HL'
      else if (p.price < prev.price) lab = kind === 'high' ? 'LH' : 'LL'
      else lab = kind === 'high' ? 'EH' : 'EL'
      return { ...p, kind, label: lab }
    })
  const highs = label(swings.swingHighs, 'high')
  const lows = label(swings.swingLows, 'low')
  const points = [...highs, ...lows].sort((a, b) => a.index - b.index)
  const lastH = highs[highs.length - 1]?.label
  const lastL = lows[lows.length - 1]?.label

  // Structural Dow Theory check: do not declare 'up' if recent macro swings are falling,
  // and do not declare 'down' if recent macro swings are rising.
  let bias: 'up' | 'down' | 'range' = 'range'
  if (lastH === 'HH' && lastL === 'HL') {
    const macroHighsAscending = highs.length >= 3 ? highs[highs.length - 1]!.price >= highs[highs.length - 3]!.price : true
    const macroLowsAscending = lows.length >= 3 ? lows[lows.length - 1]!.price >= lows[lows.length - 3]!.price : true
    bias = macroHighsAscending && macroLowsAscending ? 'up' : 'range'
  } else if (lastH === 'LH' && lastL === 'LL') {
    const macroHighsDescending = highs.length >= 3 ? highs[highs.length - 1]!.price <= highs[highs.length - 3]!.price : true
    const macroLowsDescending = lows.length >= 3 ? lows[lows.length - 1]!.price <= lows[lows.length - 3]!.price : true
    bias = macroHighsDescending && macroLowsDescending ? 'down' : 'range'
  }
  return { points, bias }
}

/**
 * Execute a custom indicator formula or function body in an isolated VM sandbox.
 *
 * Sandbox exposes:
 * - `candles`: readonly Candle[]
 * - `closes`: readonly number[]
 * - `highs`: readonly number[]
 * - `lows`: readonly number[]
 * - `volumes`: readonly number[]
 * - Built-in helper functions: `sma`, `ema`, `wma`, `rsi`, `macd`, `stochastic`, `bollinger`, `atr`, `adx`, `mfi`, `swingPoints`
 * - Standard safe Math functions
 *
 * Formula code must either:
 * 1. Define a function named `calculate(candles)` returning `(number | null)[]`
 * 2. Or return an array directly as an expression
 */
export function runCustomIndicator(
  code: string,
  candles: readonly Candle[],
  options: CustomIndicatorOptions = {},
): CustomIndicatorResult {
  const timeoutMs = Math.min(options.timeoutMs ?? 100, 1000)
  const name = options.name ?? 'custom_indicator'

  const closes = candles.map(c => c.close)
  const highs = candles.map(c => c.high)
  const lows = candles.map(c => c.low)
  const volumes = candles.map(c => c.volume)

  // Isolated safe context
  const sandbox = {
    candles,
    closes,
    highs,
    lows,
    volumes,
    Math,
    sma: (win: number) => sma(closes, win),
    ema: (win: number) => ema(closes, win),
    wma: (win: number) => wma(closes, win),
    rsi: (period = 14) => rsi(closes, period),
    macd: (fast = 12, slow = 26, sig = 9) => macd(closes, fast, slow, sig),
    stochastic: (kWin = 14, kSmooth = 3, dWin = 3) => stochastic(candles, kWin, kSmooth, dWin),
    bollinger: (win = 20, mult = 2) => bollinger(closes, win, mult),
    atr: (period = 14) => atr(candles, period),
    adx: (period = 14) => adx(candles, period),
    mfi: (period = 14) => mfi(candles, period),
    swingPoints: (left = 3, right = 3) => detectSwingPoints(candles, left, right),
  }

  const context = createContext(sandbox)

  // Wrap code into an executable evaluation block
  const wrappedScript = `
    "use strict";
    (function() {
      ${code}
      if (typeof calculate === 'function') {
        return calculate(candles);
      }
    })()
  `

  const start = performance.now()
  let rawOutput: unknown

  try {
    rawOutput = runInContext(wrappedScript, context, {
      timeout: timeoutMs,
      displayErrors: true,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('timed out') || message.includes('execution timed out')) {
      throw new Error(`Custom indicator "${name}" timed out after ${timeoutMs}ms (infinite loop or excessive computation guard).`)
    }
    throw new Error(`Custom indicator "${name}" evaluation failed: ${message}`)
  }

  const executionTimeMs = Number((performance.now() - start).toFixed(2))

  if (!Array.isArray(rawOutput)) {
    throw new Error(
      `Custom indicator "${name}" must return an array of values, received: ${typeof rawOutput}`,
    )
  }

  // Normalize array output: sanitize NaN / Infinity / undefined into null
  const values: (number | null)[] = rawOutput.map(val => {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      return null
    }
    return val
  })

  return {
    name,
    values,
    executionTimeMs,
  }
}
