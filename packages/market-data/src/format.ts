/**
 * Compact Chinese USDT / notional print for OI and liquidations.
 * 1e8+ → 亿, 1e4+ → 万, else integer. No sign for zero.
 */
export function formatUsdtCn(n: number, opts?: { signed?: boolean }): string {
  if (!Number.isFinite(n)) return '–'
  const signed = opts?.signed === true
  const sign = n < 0 ? '-' : signed && n > 0 ? '+' : ''
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(1)}万`
  if (abs >= 100) return `${sign}${abs.toFixed(0)}`
  if (abs < 0.5) return `${sign}0`
  return `${sign}${abs.toFixed(0)}`
}

/** Signed percent with fixed decimals, e.g. +1.20% / -0.80%. */
export function formatPctCn(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '–'
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}
