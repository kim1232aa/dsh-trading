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

/**
 * Execute a custom indicator formula or function body in an isolated VM sandbox.
 *
 * Sandbox exposes:
 * - `candles`: readonly Candle[]
 * - `closes`: readonly number[]
 * - `highs`: readonly number[]
 * - `lows`: readonly number[]
 * - `volumes`: readonly number[]
 * - Built-in helper functions: `sma`, `ema`, `wma`, `rsi`, `macd`, `stochastic`, `bollinger`, `atr`, `adx`, `mfi`
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
