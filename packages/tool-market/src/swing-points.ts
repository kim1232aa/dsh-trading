/** One confirmed pivot. */
export interface SwingPoint { index: number; price: number; time: string }

type Bar = { time: string; high: number; low: number }

/**
 * Strict fractal extrema: ties on either side disqualify a pivot. This shared
 * policy keeps snapshot and drawing-tool anchors identical. Callers must omit
 * an unclosed tail: the right arm of a confirmed pivot needs closed candles.
 */
export function detectSwingPoints(
  candles: readonly Bar[],
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
