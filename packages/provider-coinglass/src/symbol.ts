/**
 * Map dsh symbols (BTCUSDT) onto CoinGlass capi symbols (Binance_BTCUSDT).
 * @module
 */

const COMMON_QUOTES = ['USDT', 'USDC', 'BUSD', 'FDUSD'] as const

export type CgMarket = 'perp' | 'spot'

export interface CgSymbolParts {
  /** Normalised pair, e.g. BTCUSDT. */
  pair: string
  /** Exchange label CoinGlass expects, e.g. Binance / OKX. */
  exchange: string
  market: CgMarket
  /** Full capi symbol, e.g. Binance_BTCUSDT or Binance_SPOT_ETHUSDT. */
  cgSymbol: string
}

/** Strip separators and uppercase; append USDT when only a base coin is given. */
export function normalizePair(raw: string): string {
  let s = raw.trim().toUpperCase().replace(/[/_\-\s]/g, '')
  // Drop Futu-style prefixes if a user pastes them.
  s = s.replace(/^(CC|US|HK|SH|SZ)\./, '')
  if (!s) return s
  if (!COMMON_QUOTES.some(q => s.length > q.length && s.endsWith(q))) s += 'USDT'
  return s
}

/**
 * Build a CoinGlass symbol.
 * - `BTCUSDT` / `binance:BTCUSDT` → `Binance_BTCUSDT` (perp)
 * - `spot:ETHUSDT` → `Binance_SPOT_ETHUSDT`
 * - `okx:BTCUSDT` → `OKX_BTCUSDT`
 * - Already-formed `Binance_SPOT_ETHUSDT` passes through.
 */
export function toCgSymbol(
  raw: string,
  defaults: { exchange?: string; market?: CgMarket } = {},
): CgSymbolParts {
  const exchangeDefault = defaults.exchange ?? 'Binance'
  const marketDefault = defaults.market ?? 'perp'
  let text = raw.trim()

  // Already a CoinGlass id?
  const cgMatch = /^(Binance|OKX|Bybit|Bitget|Coinbase|Huobi|Kraken)_(SPOT_)?([A-Z0-9]+)$/i.exec(
    text.replace(/\s+/g, ''),
  )
  if (cgMatch) {
    const exchange = titleExchange(cgMatch[1]!)
    const market: CgMarket = cgMatch[2] ? 'spot' : 'perp'
    const pair = normalizePair(cgMatch[3]!)
    return {
      pair,
      exchange,
      market,
      cgSymbol: market === 'spot' ? `${exchange}_SPOT_${pair}` : `${exchange}_${pair}`,
    }
  }

  let exchange = exchangeDefault
  let market = marketDefault
  const lower = text.toLowerCase()
  if (lower.startsWith('spot:')) {
    market = 'spot'
    text = text.slice(5)
  } else if (lower.startsWith('perp:')) {
    market = 'perp'
    text = text.slice(5)
  }

  const colon = text.indexOf(':')
  if (colon > 0) {
    exchange = titleExchange(text.slice(0, colon))
    text = text.slice(colon + 1)
  }

  // Provider id prefixes from the chart column (binance / okx).
  if (/^(binance|okx|bybit|bitget|coinbase)$/i.test(text.split(/[/_\-\s]/)[0] ?? '')) {
    // no-op — already handled via colon form
  }

  const pair = normalizePair(text)
  if (!pair) throw new Error(`empty symbol after normalize: '${raw}'`)
  const cgSymbol = market === 'spot' ? `${exchange}_SPOT_${pair}` : `${exchange}_${pair}`
  return { pair, exchange, market, cgSymbol }
}

function titleExchange(ex: string): string {
  const u = ex.trim().toUpperCase()
  if (u === 'BINANCE') return 'Binance'
  if (u === 'OKX' || u === 'OKEX') return 'OKX'
  if (u === 'BYBIT') return 'Bybit'
  if (u === 'BITGET') return 'Bitget'
  if (u === 'COINBASE') return 'Coinbase'
  if (u === 'HUOBI' || u === 'HTX') return 'Huobi'
  if (u === 'KRAKEN') return 'Kraken'
  return ex.trim().charAt(0).toUpperCase() + ex.trim().slice(1)
}
