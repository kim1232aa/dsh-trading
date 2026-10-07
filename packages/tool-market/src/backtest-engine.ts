/**
 * Pure-function strategy execution and backtesting engine.
 * Generates standard BacktestArtifact directly auditable by `@dsh-trading/verdict`.
 * @module @dsh-trading/tool-market
 */

import type { Candle } from '@dsh-trading/market-data'

export type TradeSide = 'long' | 'short'

export interface BacktestTrade {
  entryTime: string
  exitTime: string
  side: TradeSide
  entryPrice: number
  exitPrice: number
  pnl: number
  returnPct: number
  holdingBars: number
  reason?: string | undefined
}

export interface BacktestOptions {
  initialCapital?: number | undefined
  feePct?: number | undefined // e.g. 0.0005 = 0.05%
  slippagePct?: number | undefined // e.g. 0.0002 = 0.02%
  allowShort?: boolean | undefined
}

export interface StrategySignal {
  action: 'enter_long' | 'exit_long' | 'enter_short' | 'exit_short' | 'hold'
  reason?: string | undefined
}

export interface StrategyContext {
  index: number
  candle: Candle
  bars: Candle[]
  position: {
    side: TradeSide
    entryPrice: number
    entryTime: string
    entryIndex: number
  } | null
}

export type StrategyFn = (ctx: StrategyContext) => StrategySignal

export interface BacktestResult {
  symbol: string
  timeframe: string
  initialCapital: number
  finalEquity: number
  totalReturnPct: number
  cagrPct?: number
  maxDrawdownPct: number
  sharpeRatio: number
  winRatePct: number
  profitFactor: number
  totalTrades: number
  winningTrades: number
  losingTrades: number
  trades: BacktestTrade[]
  equityCurve: Array<{ time: string; equity: number }>
  artifact: {
    version: 1
    symbol: string
    timeframe: string
    trades: Array<{
      entryTime: string
      exitTime: string
      side: TradeSide
      entryPrice: number
      exitPrice: number
    }>
    costs: {
      included: boolean
      feesPct: number
      slippagePct: number
    }
  }
}

/**
 * Execute a strategy function across historical candle bars deterministically.
 */
export function runBacktest(
  symbol: string,
  timeframe: string,
  bars: Candle[],
  strategy: StrategyFn,
  options: BacktestOptions = {}
): BacktestResult {
  const initialCapital = options.initialCapital ?? 10000
  const feePct = options.feePct ?? 0.0005 // default 0.05%
  const slippagePct = options.slippagePct ?? 0.0002 // default 0.02%
  const allowShort = options.allowShort ?? false

  let equity = initialCapital
  let peakEquity = initialCapital
  let maxDrawdown = 0

  const trades: BacktestTrade[] = []
  const equityCurve: Array<{ time: string; equity: number }> = []

  let currentPosition: {
    side: TradeSide
    entryPrice: number
    entryTime: string
    entryIndex: number
    shares: number
  } | null = null

  for (let i = 0; i < bars.length; i++) {
    const candle = bars[i]!
    const ctx: StrategyContext = {
      index: i,
      candle,
      bars,
      position: currentPosition
        ? {
            side: currentPosition.side,
            entryPrice: currentPosition.entryPrice,
            entryTime: currentPosition.entryTime,
            entryIndex: currentPosition.entryIndex,
          }
        : null,
    }

    const signal = strategy(ctx)

    // Handle exits first
    if (currentPosition) {
      const isExit =
        (currentPosition.side === 'long' && (signal.action === 'exit_long' || (allowShort && signal.action === 'enter_short'))) ||
        (currentPosition.side === 'short' && (signal.action === 'exit_short' || signal.action === 'enter_long'))

      if (isExit || i === bars.length - 1) {
        // Close position at candle close with slippage & fee
        let exitPrice = candle.close
        if (currentPosition.side === 'long') {
          exitPrice *= (1 - slippagePct)
        } else {
          exitPrice *= (1 + slippagePct)
        }

        const priceRatio = currentPosition.side === 'long'
          ? (exitPrice / currentPosition.entryPrice)
          : (2 - (exitPrice / currentPosition.entryPrice))

        const grossPnl = currentPosition.shares * (currentPosition.side === 'long' ? (exitPrice - currentPosition.entryPrice) : (currentPosition.entryPrice - exitPrice))
        const exitFee = (currentPosition.shares * exitPrice) * feePct
        const netPnl = grossPnl - exitFee
        const tradeReturnPct = (priceRatio - 1 - feePct) * 100

        equity += netPnl

        trades.push({
          entryTime: currentPosition.entryTime,
          exitTime: candle.time,
          side: currentPosition.side,
          entryPrice: Math.round(currentPosition.entryPrice * 10000) / 10000,
          exitPrice: Math.round(exitPrice * 10000) / 10000,
          pnl: Math.round(netPnl * 100) / 100,
          returnPct: Math.round(tradeReturnPct * 100) / 100,
          holdingBars: i - currentPosition.entryIndex,
          reason: signal.reason,
        })

        currentPosition = null
      }
    }

    // Handle entries if no position
    if (!currentPosition && i < bars.length - 1) {
      if (signal.action === 'enter_long') {
        const entryPrice = candle.close * (1 + slippagePct)
        const entryFee = equity * feePct
        const investCapital = equity - entryFee
        const shares = investCapital / entryPrice

        currentPosition = {
          side: 'long',
          entryPrice,
          entryTime: candle.time,
          entryIndex: i,
          shares,
        }
      } else if (allowShort && signal.action === 'enter_short') {
        const entryPrice = candle.close * (1 - slippagePct)
        const entryFee = equity * feePct
        const investCapital = equity - entryFee
        const shares = investCapital / entryPrice

        currentPosition = {
          side: 'short',
          entryPrice,
          entryTime: candle.time,
          entryIndex: i,
          shares,
        }
      }
    }

    // Mark equity
    let currentEquity = equity
    if (currentPosition) {
      const mtmPrice = candle.close
      const mtmPnl = currentPosition.side === 'long'
        ? currentPosition.shares * (mtmPrice - currentPosition.entryPrice)
        : currentPosition.shares * (currentPosition.entryPrice - mtmPrice)
      currentEquity += mtmPnl
    }

    if (currentEquity > peakEquity) {
      peakEquity = currentEquity
    }
    const dd = (peakEquity - currentEquity) / peakEquity
    if (dd > maxDrawdown) {
      maxDrawdown = dd
    }

    equityCurve.push({
      time: candle.time,
      equity: Math.round(currentEquity * 100) / 100,
    })
  }

  // Calculate statistics
  const totalTrades = trades.length
  const winningTrades = trades.filter((t) => t.pnl > 0).length
  const losingTrades = trades.filter((t) => t.pnl < 0).length
  const winRatePct = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0

  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((acc, t) => acc + t.pnl, 0)
  const grossLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((acc, t) => acc + t.pnl, 0))
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99.99 : 0)

  // Sharpe Ratio estimation based on trade returns
  const returns = trades.map((t) => t.returnPct / 100)
  const meanReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0
  const variance = returns.length > 1
    ? returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / (returns.length - 1)
    : 0
  const stdDev = Math.sqrt(variance)
  const sharpeRatio = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(Math.min(returns.length, 252)) : 0

  const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1]!.equity : initialCapital
  const totalReturnPct = ((finalEquity - initialCapital) / initialCapital) * 100

  return {
    symbol,
    timeframe,
    initialCapital,
    finalEquity,
    totalReturnPct: Math.round(totalReturnPct * 100) / 100,
    maxDrawdownPct: Math.round(maxDrawdown * 10000) / 100,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    winRatePct: Math.round(winRatePct * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    totalTrades,
    winningTrades,
    losingTrades,
    trades,
    equityCurve,
    artifact: {
      version: 1,
      symbol,
      timeframe,
      trades: trades.map((t) => ({
        entryTime: t.entryTime,
        exitTime: t.exitTime,
        side: t.side,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
      })),
      costs: {
        included: true,
        feesPct: feePct * 100,
        slippagePct: slippagePct * 100,
      },
    },
  }
}

// ---------------- Preset Classical Strategies ----------------

/**
 * Dual EMA trend following strategy.
 */
/** Which sides a preset strategy may trade. `both` = stop-and-reverse. */
export type StrategyDirection = 'long' | 'short' | 'both'

export function createDualEmaStrategy(fastPeriod = 12, slowPeriod = 26, direction: StrategyDirection = 'long'): StrategyFn {
  const canLong = direction !== 'short'
  const canShort = direction !== 'long'
  const calcEma = (bars: Candle[], period: number, endIdx: number): number => {
    const k = 2 / (period + 1)
    let ema = bars[Math.max(0, endIdx - period * 2)]?.close ?? bars[0]!.close
    for (let i = Math.max(0, endIdx - period * 2) + 1; i <= endIdx; i++) {
      ema = bars[i]!.close * k + ema * (1 - k)
    }
    return ema
  }

  return (ctx) => {
    if (ctx.index < slowPeriod + 1) return { action: 'hold' }

    const fastCurrent = calcEma(ctx.bars, fastPeriod, ctx.index)
    const fastPrev = calcEma(ctx.bars, fastPeriod, ctx.index - 1)
    const slowCurrent = calcEma(ctx.bars, slowPeriod, ctx.index)
    const slowPrev = calcEma(ctx.bars, slowPeriod, ctx.index - 1)

    const goldenCross = fastPrev <= slowPrev && fastCurrent > slowCurrent
    const deathCross = fastPrev >= slowPrev && fastCurrent < slowCurrent

    if (goldenCross) {
      const reason = `EMA(${fastPeriod}) golden cross EMA(${slowPeriod})`
      return canLong ? { action: 'enter_long', reason } : { action: 'exit_short', reason }
    }
    if (deathCross) {
      const reason = `EMA(${fastPeriod}) death cross EMA(${slowPeriod})`
      return canShort ? { action: 'enter_short', reason } : { action: 'exit_long', reason }
    }

    return { action: 'hold' }
  }
}

/**
 * Donchian Breakout (Turtle trading) strategy.
 */
export function createDonchianStrategy(entryPeriod = 20, exitPeriod = 10, direction: StrategyDirection = 'long'): StrategyFn {
  const canLong = direction !== 'short'
  const canShort = direction !== 'long'
  const extremes = (bars: Candle[], end: number, period: number): { hi: number; lo: number } => {
    let hi = -Infinity
    let lo = Infinity
    for (let i = Math.max(0, end - period); i < end; i++) {
      if (bars[i]!.high > hi) hi = bars[i]!.high
      if (bars[i]!.low < lo) lo = bars[i]!.low
    }
    return { hi, lo }
  }

  return (ctx) => {
    if (ctx.index < entryPeriod) return { action: 'hold' }

    const entry = extremes(ctx.bars, ctx.index, entryPeriod)
    const exit = extremes(ctx.bars, ctx.index, exitPeriod)
    const close = ctx.candle.close
    const side = ctx.position?.side

    if (side === undefined) {
      if (canLong && close > entry.hi) return { action: 'enter_long', reason: `Broke above ${entryPeriod}-bar high (${entry.hi})` }
      if (canShort && close < entry.lo) return { action: 'enter_short', reason: `Broke below ${entryPeriod}-bar low (${entry.lo})` }
      return { action: 'hold' }
    }
    if (side === 'long' && close < exit.lo) {
      if (canShort && close < entry.lo) return { action: 'enter_short', reason: `Reversed below ${entryPeriod}-bar low (${entry.lo})` }
      return { action: 'exit_long', reason: `Fell below ${exitPeriod}-bar low (${exit.lo})` }
    }
    if (side === 'short' && close > exit.hi) {
      if (canLong && close > entry.hi) return { action: 'enter_long', reason: `Reversed above ${entryPeriod}-bar high (${entry.hi})` }
      return { action: 'exit_short', reason: `Rose above ${exitPeriod}-bar high (${exit.hi})` }
    }

    return { action: 'hold' }
  }
}
