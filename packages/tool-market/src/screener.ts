/**
 * Pure-function market screener engine.
 * Scans a basket of symbols across multiple timeframe regimes to identify
 * technical setups — both bullish and bearish patterns.
 * @module @dsh-trading/tool-market
 */

import type { Candle, MarketDataProvider, Timeframe } from '@dsh-trading/market-data'

export type ScreenerPattern =
  | 'bullish_alignment' | 'volume_breakout' | 'oversold_reversal'
  | 'bearish_alignment' | 'volume_breakdown' | 'overbought_reversal'

export interface ScreenerMatch {
  symbol: string
  pattern: ScreenerPattern
  score: number // 0 ~ 100
  title: string
  details: string
  close: number
  changePct?: number | undefined
  metrics: Record<string, number | string>
}

export interface ScreenerOptions {
  timeframe?: Timeframe
  limit?: number
  minVolume?: number
}

/**
 * Scan for Moving Average Bullish Alignment (MA20 > MA50 > MA200 and Price > MA20).
 */
export function checkBullishAlignment(bars: Candle[]): ScreenerMatch | null {
  if (bars.length < 200) return null

  const calcSma = (period: number): number => {
    let sum = 0
    for (let i = bars.length - period; i < bars.length; i++) {
      sum += bars[i]!.close
    }
    return sum / period
  }

  const sma20 = calcSma(20)
  const sma50 = calcSma(50)
  const sma200 = calcSma(200)
  const current = bars[bars.length - 1]!

  if (current.close > sma20 && sma20 > sma50 && sma50 > sma200) {
    const spreadPct = ((sma20 - sma200) / sma200) * 100
    const score = Math.min(100, Math.round(50 + spreadPct * 5))
    return {
      symbol: '',
      pattern: 'bullish_alignment',
      score,
      title: '均线多头排列 (MA20 > MA50 > MA200)',
      details: `现价 ${current.close.toFixed(2)} 位于各周期均线上方，多头趋势发散`,
      close: current.close,
      metrics: {
        sma20: Number(sma20.toFixed(2)),
        sma50: Number(sma50.toFixed(2)),
        sma200: Number(sma200.toFixed(2)),
        spreadPct: Number(spreadPct.toFixed(2)),
      },
    }
  }

  return null
}

/**
 * Scan for Volume Breakout (Volume > 1.8x 20-bar median & Close > highest high of last 20 bars).
 */
export function checkVolumeBreakout(bars: Candle[]): ScreenerMatch | null {
  if (bars.length < 25) return null

  const current = bars[bars.length - 1]!
  const prevBars = bars.slice(bars.length - 21, bars.length - 1)

  // 20-bar highest high before current
  const highestPrevHigh = Math.max(...prevBars.map((b) => b.high))

  // 20-bar volume median
  const sortedVols = [...prevBars.map((b) => b.volume)].sort((a, b) => a - b)
  const medianVol = sortedVols[Math.floor(sortedVols.length / 2)] ?? 1

  const volRatio = medianVol > 0 ? current.volume / medianVol : 1

  if (current.close > highestPrevHigh && volRatio >= 1.8) {
    const breakoutPct = ((current.close - highestPrevHigh) / highestPrevHigh) * 100
    const score = Math.min(100, Math.round(60 + volRatio * 10 + breakoutPct * 5))
    return {
      symbol: '',
      pattern: 'volume_breakout',
      score,
      title: '放量突破前期阻力平台',
      details: `现价 ${current.close.toFixed(2)} 突破近20根K线高点 ${highestPrevHigh.toFixed(2)}，成交量达中位数的 ${volRatio.toFixed(1)} 倍`,
      close: current.close,
      metrics: {
        breakoutPrice: Number(highestPrevHigh.toFixed(2)),
        volumeRatio: Number(volRatio.toFixed(2)),
        breakoutPct: Number(breakoutPct.toFixed(2)),
      },
    }
  }

  return null
}

/**
 * Scan for Oversold Rebound (RSI14 < 32 with a bullish reversal candlestick).
 */
export function checkOversoldReversal(bars: Candle[]): ScreenerMatch | null {
  if (bars.length < 20) return null

  const calcRsi = (period = 14): number => {
    let gains = 0
    let losses = 0
    for (let i = bars.length - period; i < bars.length; i++) {
      const diff = bars[i]!.close - bars[i - 1]!.close
      if (diff >= 0) gains += diff
      else losses -= diff
    }
    const avgGain = gains / period
    const avgLoss = losses / period
    if (avgLoss === 0) return 100
    const rs = avgGain / avgLoss
    return 100 - 100 / (1 + rs)
  }

  const rsi = calcRsi(14)
  const current = bars[bars.length - 1]!
  const prev = bars[bars.length - 2]!

  // Rebound candle: green candle after red candle, or lower shadow
  const isGreen = current.close > current.open
  const lowerShadow = Math.min(current.open, current.close) - current.low
  const body = Math.abs(current.close - current.open)

  if (rsi <= 32 && (isGreen || lowerShadow > body * 1.5)) {
    const score = Math.min(100, Math.round((35 - rsi) * 2 + 60))
    return {
      symbol: '',
      pattern: 'oversold_reversal',
      score,
      title: '超卖底背离/企稳反弹信号',
      details: `RSI(14) 读数 ${rsi.toFixed(1)} 处于极度超卖区，最新K线出现反弹企稳形态`,
      close: current.close,
      metrics: {
        rsi14: Number(rsi.toFixed(1)),
        isGreenCandle: isGreen ? 1 : 0,
      },
    }
  }

  return null
}

/**
 * Scan for Moving Average Bearish Alignment (MA20 < MA50 < MA200 and Price < MA20).
 */
export function checkBearishAlignment(bars: Candle[]): ScreenerMatch | null {
  if (bars.length < 200) return null

  const calcSma = (period: number): number => {
    let sum = 0
    for (let i = bars.length - period; i < bars.length; i++) {
      sum += bars[i]!.close
    }
    return sum / period
  }

  const sma20 = calcSma(20)
  const sma50 = calcSma(50)
  const sma200 = calcSma(200)
  const current = bars[bars.length - 1]!

  if (current.close < sma20 && sma20 < sma50 && sma50 < sma200) {
    const spreadPct = ((sma200 - sma20) / sma200) * 100
    const score = Math.min(100, Math.round(50 + spreadPct * 5))
    return {
      symbol: '',
      pattern: 'bearish_alignment',
      score,
      title: '均线空头排列 (MA20 < MA50 < MA200)',
      details: `现价 ${current.close.toFixed(2)} 位于各周期均线下方，空头趋势发散`,
      close: current.close,
      metrics: {
        sma20: Number(sma20.toFixed(2)),
        sma50: Number(sma50.toFixed(2)),
        sma200: Number(sma200.toFixed(2)),
        spreadPct: Number(spreadPct.toFixed(2)),
      },
    }
  }

  return null
}

/**
 * Scan for Volume Breakdown (Volume > 1.8x 20-bar median & Close < lowest low of last 20 bars).
 */
export function checkVolumeBreakdown(bars: Candle[]): ScreenerMatch | null {
  if (bars.length < 25) return null

  const current = bars[bars.length - 1]!
  const prevBars = bars.slice(bars.length - 21, bars.length - 1)

  const lowestPrevLow = Math.min(...prevBars.map((b) => b.low))

  const sortedVols = [...prevBars.map((b) => b.volume)].sort((a, b) => a - b)
  const medianVol = sortedVols[Math.floor(sortedVols.length / 2)] ?? 1

  const volRatio = medianVol > 0 ? current.volume / medianVol : 1

  if (current.close < lowestPrevLow && volRatio >= 1.8) {
    const breakdownPct = ((lowestPrevLow - current.close) / lowestPrevLow) * 100
    const score = Math.min(100, Math.round(60 + volRatio * 10 + breakdownPct * 5))
    return {
      symbol: '',
      pattern: 'volume_breakdown',
      score,
      title: '放量跌破前期支撑平台',
      details: `现价 ${current.close.toFixed(2)} 跌破近20根K线低点 ${lowestPrevLow.toFixed(2)}，成交量达中位数的 ${volRatio.toFixed(1)} 倍`,
      close: current.close,
      metrics: {
        breakdownPrice: Number(lowestPrevLow.toFixed(2)),
        volumeRatio: Number(volRatio.toFixed(2)),
        breakdownPct: Number(breakdownPct.toFixed(2)),
      },
    }
  }

  return null
}

/**
 * Scan for Overbought Reversal (RSI14 > 68 with a bearish reversal candlestick).
 */
export function checkOverboughtReversal(bars: Candle[]): ScreenerMatch | null {
  if (bars.length < 20) return null

  const calcRsi = (period = 14): number => {
    let gains = 0
    let losses = 0
    for (let i = bars.length - period; i < bars.length; i++) {
      const diff = bars[i]!.close - bars[i - 1]!.close
      if (diff >= 0) gains += diff
      else losses -= diff
    }
    const avgGain = gains / period
    const avgLoss = losses / period
    if (avgLoss === 0) return 100
    const rs = avgGain / avgLoss
    return 100 - 100 / (1 + rs)
  }

  const rsiVal = calcRsi(14)
  const current = bars[bars.length - 1]!

  const isRed = current.close < current.open
  const upperShadow = current.high - Math.max(current.open, current.close)
  const body = Math.abs(current.close - current.open)

  if (rsiVal >= 68 && (isRed || upperShadow > body * 1.5)) {
    const score = Math.min(100, Math.round((rsiVal - 65) * 2 + 60))
    return {
      symbol: '',
      pattern: 'overbought_reversal',
      score,
      title: '超买顶背离/见顶反转信号',
      details: `RSI(14) 读数 ${rsiVal.toFixed(1)} 处于极度超买区，最新K线出现滞涨/反转形态`,
      close: current.close,
      metrics: {
        rsi14: Number(rsiVal.toFixed(1)),
        isRedCandle: isRed ? 1 : 0,
      },
    }
  }

  return null
}

/**
 * Scan a universe of symbols against screener criteria.
 */
export async function screenUniverse(
  provider: MarketDataProvider,
  symbols: string[],
  timeframe: Timeframe = '1d',
  patterns: ScreenerPattern[] = [
    'bullish_alignment',
    'volume_breakout',
    'oversold_reversal',
    'bearish_alignment',
    'volume_breakdown',
    'overbought_reversal',
  ]
): Promise<ScreenerMatch[]> {
  const checkers: Record<ScreenerPattern, (bars: Candle[]) => ScreenerMatch | null> = {
    bullish_alignment: checkBullishAlignment,
    volume_breakout: checkVolumeBreakout,
    oversold_reversal: checkOversoldReversal,
    bearish_alignment: checkBearishAlignment,
    volume_breakdown: checkVolumeBreakdown,
    overbought_reversal: checkOverboughtReversal,
  }

  const matches: ScreenerMatch[] = []

  for (const symbol of symbols) {
    try {
      const bars = await provider.getOhlcv({ symbol, timeframe, limit: 220 })
      if (!bars || bars.length < 30) continue

      for (const pat of patterns) {
        const checker = checkers[pat]
        if (!checker) continue
        const match = checker(bars)
        if (match) {
          match.symbol = symbol
          matches.push(match)
        }
      }
    } catch {
      // Continue next symbol if individual fetch fails
    }
  }

  return matches.sort((a, b) => b.score - a.score)
}
