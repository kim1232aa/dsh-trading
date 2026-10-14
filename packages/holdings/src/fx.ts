/**
 * FX rates for multi-currency portfolio NAV.
 *
 * 口径 (crypto desk default):
 * - Base currency defaults to USDT (stablecoin book).
 * - USD and USDT are treated as near-par; when the feed quotes `usd.usdt`,
 *   we honour it, otherwise USDT = USD = 1.
 * - Fiat (CNY) converts via a public USD book, then into the base.
 * - Sources (no API key): 1) jsdelivr currency-api  2) open.er-api.com
 * - Research-only mark: not a broker settlement rate; stamp `asOf` + `source`.
 * @module @dsh-trading/holdings
 */

import type { Currency } from './types.js'

export type FxBook = {
  baseCurrency: Currency
  /** Multiply an amount in `currency` by rates[currency] to get base units. */
  rates: Record<string, number>
  source: string
  asOf: string
}

const FX_URLS = [
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
  'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
]

async function fetchUsdBook(): Promise<{ date: string; usd: Record<string, number>; source: string }> {
  let lastErr: unknown
  for (const url of FX_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { date?: string; usd?: Record<string, number> }
      if (!json.usd || typeof json.usd.cny !== 'number') throw new Error('missing usd.cny')
      return { date: json.date ?? new Date().toISOString().slice(0, 10), usd: json.usd, source: url }
    } catch (e) {
      lastErr = e
    }
  }
  // Last resort: open.er-api.com
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json() as { result?: string; rates?: Record<string, number>; time_last_update_utc?: string }
    if (json.result !== 'success' || !json.rates?.['CNY']) throw new Error('er-api bad payload')
    const usd: Record<string, number> = {
      cny: json.rates['CNY']!,
      usdt: 1,
      usd: 1,
    }
    return {
      date: (json.time_last_update_utc ?? new Date().toISOString()).slice(0, 16),
      usd,
      source: 'https://open.er-api.com/v6/latest/USD',
    }
  } catch (e) {
    throw lastErr ?? e
  }
}

/** Build a rate book: 1 unit of each known currency → `baseCurrency`. */
export async function fetchFxBook(baseCurrency: Currency = 'USDT'): Promise<FxBook> {
  const book = await fetchUsdBook()
  const usdPerUsdt = book.usd['usdt'] && book.usd['usdt'] > 0 ? book.usd['usdt'] : 1
  // amount_in_USD = amount_in_CCY / (USD per CCY) for fiat quoted as USD→CCY
  const toUsd = (ccy: string): number => {
    if (ccy === 'USD') return 1
    if (ccy === 'USDT') return 1 / usdPerUsdt // 1 USDT → USD
    const perUsd = book.usd[ccy.toLowerCase()]
    if (perUsd && perUsd > 0) return 1 / perUsd
    return 1 // unknown: leave unconverted (honest 1:1 with a note via source)
  }
  const usdToBase = baseCurrency === 'USD' ? 1
    : baseCurrency === 'USDT' ? usdPerUsdt
    : (() => {
      const perUsd = book.usd[baseCurrency.toLowerCase()]
      return perUsd && perUsd > 0 ? perUsd : 1
    })()

  const currencies: Currency[] = ['USDT', 'USD', 'CNY']
  const rates: Record<string, number> = {}
  for (const c of currencies) {
    rates[c] = Number((toUsd(c) * usdToBase).toFixed(8))
  }
  return {
    baseCurrency,
    rates,
    source: book.source,
    asOf: book.date,
  }
}

/** Convert an amount in `currency` into the FX book's base. */
export function toBase(amount: number, currency: string, book: FxBook): number {
  const r = book.rates[currency] ?? book.rates[currency.toUpperCase()] ?? 1
  return amount * r
}
