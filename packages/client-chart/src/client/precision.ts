/**
 * Dynamic price precision and formatting for assets across different magnitudes
 * (e.g. BTC/ETH 2 decimals, XRP/SUI 4 decimals, DOGE 5 decimals, PEPE/SHIB 7-8 decimals).
 */

export function detectPricePrecision(candles?: { open?: number; high?: number; low?: number; close?: number }[]): number {
  if (!candles || candles.length === 0) return 2
  let maxDec = 2
  const sample = candles.slice(-50)
  for (const c of sample) {
    for (const v of [c.open, c.high, c.low, c.close]) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        const s = v.toString()
        const dot = s.indexOf('.')
        if (dot !== -1) {
          maxDec = Math.max(maxDec, s.length - dot - 1)
        }
      }
    }
  }

  // Guard against round samples by checking last non-zero price magnitude
  const lastClose = candles[candles.length - 1]?.close ?? candles[0]?.close ?? 1
  if (lastClose > 0) {
    if (lastClose < 0.0001) maxDec = Math.max(maxDec, 8)
    else if (lastClose < 0.001) maxDec = Math.max(maxDec, 7)
    else if (lastClose < 0.01) maxDec = Math.max(maxDec, 6)
    else if (lastClose < 0.1) maxDec = Math.max(maxDec, 5)
    else if (lastClose < 1) maxDec = Math.max(maxDec, 4)
    else if (lastClose < 10) maxDec = Math.max(maxDec, 3)
  }

  return Math.min(8, Math.max(2, maxDec))
}

export function formatPrice(v: number | undefined | null, precision?: number): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '–'
  if (typeof precision === 'number' && precision >= 0) return v.toFixed(precision)
  const abs = Math.abs(v)
  if (abs === 0) return '0.00'
  if (abs >= 500) return v.toFixed(2)
  if (abs >= 10) return v.toFixed(2)
  if (abs >= 1) return v.toFixed(4)
  if (abs >= 0.1) return v.toFixed(4)
  if (abs >= 0.01) return v.toFixed(5)
  if (abs >= 0.001) return v.toFixed(6)
  if (abs >= 0.0001) return v.toFixed(7)
  return v.toFixed(8)
}
