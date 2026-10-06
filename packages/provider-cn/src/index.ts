import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  Candle,
  FundamentalsPackage,
  InstrumentInfo,
  MarketDataProvider,
  MoneyFlow,
  OhlcvQuery,
  Orderbook,
  Timeframe,
} from '@dsh-trading/market-data'

export const name = 'provider-cn'
export const inject = ['marketData']

export interface Config {
  id: string
  eastmoneyBaseURL: string
  sinaBaseURL: string
  tencentBaseURL: string
}

export const Config: z<Config> = z.object({
  id: z.string().default('cn'),
  eastmoneyBaseURL: z.string().default('https://push2his.eastmoney.com'),
  sinaBaseURL: z.string().default('https://quotes.sina.cn'),
  tencentBaseURL: z.string().default('https://qt.gtimg.cn'),
}) as unknown as z<Config>

export const ALL_CN_TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '1d', '1w']

const EM_KLT_MAP: Partial<Record<Timeframe, number>> = {
  '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '1d': 101, '1w': 102,
}

/** EM and Sina label intraday bars by their CLOSE (09:35 = the first 5m bar); the seam wants bar-open. */
const INTRADAY_MS: Partial<Record<Timeframe, number>> = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3 }

export function toBarOpen(bars: Candle[], tf: Timeframe): Candle[] {
  const ms = INTRADAY_MS[tf]
  return ms === undefined ? bars : bars.map(b => ({ ...b, time: new Date(Date.parse(b.time) - ms).toISOString() }))
}

const SINA_SCALE_MAP: Partial<Record<Timeframe, number>> = {
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '1d': 240,
}

export interface CnSymbolInfo {
  code: string
  market: 'sh' | 'sz' | 'bj'
  secid: string
  sinaSymbol: string
}

export function parseCnSymbol(raw: string): CnSymbolInfo {
  const s = raw.trim().replace(/[.\-_\s]/g, '')
  const upper = s.toUpperCase()

  let code = ''
  let market: 'sh' | 'sz' | 'bj' = 'sh'

  if (/^(SH|SZ|BJ)\d{6}$/i.test(upper)) {
    const p = upper.slice(0, 2).toLowerCase() as 'sh' | 'sz' | 'bj'
    market = p
    code = upper.slice(2)
  } else if (/^\d{6}(SH|SZ|BJ)$/i.test(upper)) {
    const p = upper.slice(6).toLowerCase() as 'sh' | 'sz' | 'bj'
    market = p
    code = upper.slice(0, 6)
  } else if (/^\d{6}$/.test(upper)) {
    code = upper
    if (code.startsWith('6') || code.startsWith('900') || code.startsWith('688') || code.startsWith('689')) {
      market = 'sh'
    } else if (code.startsWith('00') || code.startsWith('30') || code.startsWith('200') || code.startsWith('399')) {
      market = 'sz'
    } else if (code.startsWith('920') || code.startsWith('43') || code.startsWith('83') || code.startsWith('87') || code.startsWith('88')) {
      market = 'bj'
    } else {
      market = 'sh'
    }
  } else {
    throw new Error(`Invalid A-share symbol format: '${raw}' (expected e.g. 600519, sh600519, 000001, 300750, 920002)`)
  }

  const emPrefix = market === 'sh' ? '1.' : '0.'
  const secid = `${emPrefix}${code}`
  const sinaPrefix = market === 'sh' ? 'sh' : market === 'sz' ? 'sz' : 'bj'
  const sinaSymbol = `${sinaPrefix}${code}`

  return { code, market, secid, sinaSymbol }
}

export function isCnSymbol(raw: string): boolean {
  try {
    parseCnSymbol(raw)
    return true
  } catch {
    return false
  }
}

/** Converts Beijing local market time (UTC+8) to UTC ISO-8601 string. */
export function cnTimeToIso(timeStr: string): string {
  const clean = timeStr.trim().replace(/[h]/g, ':')
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    return new Date(`${clean}T09:30:00+08:00`).toISOString()
  }
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(clean)) {
    const [d, t] = clean.split(/\s+/)
    return new Date(`${d}T${t}:00+08:00`).toISOString()
  }
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(clean)) {
    const [d, t] = clean.split(/\s+/)
    return new Date(`${d}T${t}+08:00`).toISOString()
  }
  return new Date(clean).toISOString()
}

export function formatRmbAmount(amount: number): string {
  const abs = Math.abs(amount)
  const sign = amount >= 0 ? '+' : '-'
  if (abs >= 1e8) {
    return `${sign}${(abs / 1e8).toFixed(2)}亿`
  }
  if (abs >= 1e4) {
    return `${sign}${(abs / 1e4).toFixed(1)}万`
  }
  return `${sign}${abs.toFixed(0)}元`
}

/** Parses raw Tencent stock quote (qt.gtimg.cn) into normalized Orderbook and Fundamentals. */
export function parseTencentQuote(raw: string, symbol: string): {
  orderbook: Orderbook
  fundamentals: FundamentalsPackage
} {
  const match = raw.match(/"([^"]+)"/)
  const content = match ? match[1]! : raw
  const parts = content.split('~')

  const timeRaw = parts[30] // e.g. 20261002150000
  let isoTime = new Date().toISOString()
  if (timeRaw && timeRaw.length === 14) {
    isoTime = cnTimeToIso(`${timeRaw.slice(0, 4)}-${timeRaw.slice(4, 6)}-${timeRaw.slice(6, 8)} ${timeRaw.slice(8, 10)}:${timeRaw.slice(10, 12)}:${timeRaw.slice(12, 14)}`)
  }

  // Bids: Buy 1 to Buy 5 (indices 9/10, 11/12, 13/14, 15/16, 17/18)
  const bids: Array<{ price: number; quantity: number }> = [
    { price: Number(parts[9]) || 0, quantity: (Number(parts[10]) || 0) * 100 },
    { price: Number(parts[11]) || 0, quantity: (Number(parts[12]) || 0) * 100 },
    { price: Number(parts[13]) || 0, quantity: (Number(parts[14]) || 0) * 100 },
    { price: Number(parts[15]) || 0, quantity: (Number(parts[16]) || 0) * 100 },
    { price: Number(parts[17]) || 0, quantity: (Number(parts[18]) || 0) * 100 },
  ].filter(b => b.price > 0)

  // Asks: Sell 1 to Sell 5 (indices 19/20, 21/22, 23/24, 25/26, 27/28)
  const asks: Array<{ price: number; quantity: number }> = [
    { price: Number(parts[19]) || 0, quantity: (Number(parts[20]) || 0) * 100 },
    { price: Number(parts[21]) || 0, quantity: (Number(parts[22]) || 0) * 100 },
    { price: Number(parts[23]) || 0, quantity: (Number(parts[24]) || 0) * 100 },
    { price: Number(parts[25]) || 0, quantity: (Number(parts[26]) || 0) * 100 },
    { price: Number(parts[27]) || 0, quantity: (Number(parts[28]) || 0) * 100 },
  ].filter(a => a.price > 0)

  const bestBid = bids[0]?.price
  const bestAsk = asks[0]?.price
  const midPrice = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : (Number(parts[3]) || undefined)
  const spread = bestBid && bestAsk ? Number((bestAsk - bestBid).toFixed(4)) : undefined

  const peTtm = Number(parts[39]) || undefined
  const pb = Number(parts[45]) || undefined
  const circulatingMarketCap = (Number(parts[43]) || 0) * 1e8 || undefined
  const marketCap = (Number(parts[44]) || 0) * 1e8 || undefined

  return {
    orderbook: {
      symbol,
      time: isoTime,
      bids,
      asks,
      midPrice,
      spread,
    },
    fundamentals: {
      symbol,
      time: isoTime,
      peTtm,
      pb,
      circulatingMarketCap,
      marketCap,
    },
  }
}

export class CnMarketProvider implements MarketDataProvider {
  readonly id: string
  readonly description: string

  private readonly representativeSymbols: InstrumentInfo[] = [
    { symbol: '600519', assetClass: 'equity', description: '贵州茅台 (沪A)' },
    { symbol: '000001', assetClass: 'equity', description: '平安银行 (深A)' },
    { symbol: '300750', assetClass: 'equity', description: '宁德时代 (创业板)' },
    { symbol: '688981', assetClass: 'equity', description: '中芯国际 (科创板)' },
    { symbol: '002594', assetClass: 'equity', description: '比亚迪 (深A)' },
    { symbol: '601318', assetClass: 'equity', description: '中国平安 (沪A)' },
    { symbol: '601899', assetClass: 'equity', description: '紫金矿业 (沪A)' },
    { symbol: '000333', assetClass: 'equity', description: '美的集团 (深A)' },
    { symbol: '920002', assetClass: 'equity', description: '万达轴承 (北交所)' },
    { symbol: 'sh000001', assetClass: 'index', description: '上证指数' },
    { symbol: 'sz399001', assetClass: 'index', description: '深证成指' },
    { symbol: 'sz399006', assetClass: 'index', description: '创业板指' },
  ].map(s => ({ ...s, timeframes: [...ALL_CN_TIMEFRAMES] }))

  constructor(
    id: string,
    private readonly emBaseURL: string,
    private readonly sinaBaseURL: string,
    private readonly tencentBaseURL: string = 'https://qt.gtimg.cn',
  ) {
    this.id = id
    this.description = 'A股行情与资金流 (东财主源 + 新浪容灾 + 腾讯极速盘口)'
  }

  matchesSymbol(symbol: string): boolean {
    return isCnSymbol(symbol)
  }

  async listSymbols(): Promise<InstrumentInfo[]> {
    return this.representativeSymbols
  }

  async getOhlcv(query: OhlcvQuery): Promise<Candle[]> {
    if (!ALL_CN_TIMEFRAMES.includes(query.timeframe)) throw new Error(`A股没有 ${query.timeframe} 周期 (可用: ${ALL_CN_TIMEFRAMES.join(', ')})`)
    const sym = parseCnSymbol(query.symbol)
    try {
      return toBarOpen(await this.fetchEastmoney(sym, query), query.timeframe)
    } catch (emErr) {
      // Gracefully fall back to Sina if Eastmoney is down or network blips
      try {
        return toBarOpen(await this.fetchSina(sym, query), query.timeframe)
      } catch (sinaErr) {
        throw new Error(`CN market data failed for '${query.symbol}': Eastmoney (${(emErr as Error).message}), Sina (${(sinaErr as Error).message})`)
      }
    }
  }

  private async fetchEastmoney(sym: CnSymbolInfo, query: OhlcvQuery): Promise<Candle[]> {
    const klt = EM_KLT_MAP[query.timeframe]!
    const limit = Math.min(query.limit ?? 200, 1000)

    const url = new URL('/api/qt/stock/kline/get', this.emBaseURL)
    url.searchParams.set('secid', sym.secid)
    url.searchParams.set('klt', String(klt))
    url.searchParams.set('fqt', '1') // 前复权
    url.searchParams.set('end', '20500101') // without an end EM answers rc=102, data=null
    url.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6')
    url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61')
    url.searchParams.set('lmt', String(limit))

    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const data = await res.json() as { data?: { klines?: string[] } }
    const rawKlines = data?.data?.klines
    if (!rawKlines || !Array.isArray(rawKlines) || rawKlines.length === 0) {
      throw new Error(`empty klines from Eastmoney for ${sym.secid}`)
    }

    return rawKlines.map(line => {
      // format: "time,open,close,high,low,volume,amount,amplitude,changePct,changeAmount,turnover"
      const parts = line.split(',')
      return {
        time: cnTimeToIso(parts[0]!),
        open: Number(parts[1]),
        close: Number(parts[2]),
        high: Number(parts[3]),
        low: Number(parts[4]),
        volume: Number(parts[5]) * 100, // EM reports 手 (100 shares); Sina reports shares
      }
    })
  }

  private async fetchSina(sym: CnSymbolInfo, query: OhlcvQuery): Promise<Candle[]> {
    const scale = SINA_SCALE_MAP[query.timeframe]
    if (scale === undefined) throw new Error(`新浪无 ${query.timeframe} 周期`)
    const limit = Math.min(query.limit ?? 200, 1000)

    const url = new URL(`/cn/api/jsonp_v2.php/var%20_${sym.sinaSymbol}=/CN_MarketData.getKLineData`, this.sinaBaseURL)
    url.searchParams.set('symbol', sym.sinaSymbol)
    url.searchParams.set('scale', String(scale))
    url.searchParams.set('ma', 'no')
    url.searchParams.set('datalen', String(limit))

    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const text = await res.text()
    const jsonMatch = text.match(/\(\s*(\[.*?\])\s*\)/s)
    if (!jsonMatch || !jsonMatch[1]) {
      throw new Error(`invalid Sina JSONP format: ${text.slice(0, 100)}`)
    }

    const rows = JSON.parse(jsonMatch[1]) as Array<{
      day: string
      open: string
      high: string
      low: string
      close: string
      volume: string
    }>

    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`empty klines from Sina for ${sym.sinaSymbol}`)
    }

    return rows.map(r => ({
      time: cnTimeToIso(r.day),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }))
  }

  async getMoneyFlow(symbol: string): Promise<MoneyFlow> {
    const sym = parseCnSymbol(symbol)
    const url = new URL('/api/qt/stock/fflow/kline/get', this.emBaseURL)
    url.searchParams.set('secid', sym.secid)
    url.searchParams.set('klt', '101')
    url.searchParams.set('fields1', 'f1,f2,f3,f7')
    url.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65')
    url.searchParams.set('lmt', '5')

    const res = await fetch(url)
    if (!res.ok) throw new Error(`Eastmoney fflow HTTP ${res.status}`)

    const json = await res.json() as {
      data?: {
        name?: string
        klines?: string[]
      }
    }

    const klines = json?.data?.klines
    if (!klines || klines.length === 0) {
      throw new Error(`no money flow data returned for ${symbol}`)
    }

    // Latest kline row: "date,主力净流入,小单净流入,中单净流入,大单净流入,超大单净流入"
    const latest = klines[klines.length - 1]!.split(',')
    const date = latest[0]!
    const mainNet = Number(latest[1] || 0)
    const smallNet = Number(latest[2] || 0)
    const mediumNet = Number(latest[3] || 0)
    const largeNet = Number(latest[4] || 0)
    const superLargeNet = Number(latest[5] || 0)

    // Also probe quote to get turnover for ratio
    let mainRatioPct: number | null = null
    try {
      const qUrl = new URL('https://push2.eastmoney.com/api/qt/stock/get')
      qUrl.searchParams.set('secid', sym.secid)
      qUrl.searchParams.set('fields', 'f48,f58')
      const qRes = await fetch(qUrl)
      if (qRes.ok) {
        const qJson = await qRes.json() as { data?: { f48?: number } }
        const turnover = qJson?.data?.f48
        if (turnover && turnover > 0) {
          mainRatioPct = Number(((mainNet / turnover) * 100).toFixed(2))
        }
      }
    } catch {
      // ratio optional
    }

    const stockName = json?.data?.name ? `${json.data.name} ` : ''
    const ratioStr = mainRatioPct !== null ? ` (${mainRatioPct >= 0 ? '+' : ''}${mainRatioPct}%)` : ''
    const summary = `${stockName}主力净流入 ${formatRmbAmount(mainNet)}${ratioStr} | 超大单 ${formatRmbAmount(superLargeNet)} | 大单 ${formatRmbAmount(largeNet)} | 散户(中小单) ${formatRmbAmount(smallNet + mediumNet)}`

    return {
      symbol,
      time: cnTimeToIso(date),
      netInflow: mainNet,
      superLargeInflow: superLargeNet,
      largeInflow: largeNet,
      mediumInflow: mediumNet,
      smallInflow: smallNet,
      mainRatioPct,
      summary,
    }
  }

  async getOrderbook(symbol: string): Promise<Orderbook> {
    const { sinaSymbol } = parseCnSymbol(symbol)
    const res = await fetch(`${this.tencentBaseURL}/q=${sinaSymbol}`)
    if (!res.ok) throw new Error(`Tencent quote HTTP ${res.status} for ${symbol}`)
    const text = await res.text()
    const { orderbook } = parseTencentQuote(text, symbol)
    return orderbook
  }

  async getFundamentals(symbol: string): Promise<FundamentalsPackage> {
    const { sinaSymbol } = parseCnSymbol(symbol)
    const res = await fetch(`${this.tencentBaseURL}/q=${sinaSymbol}`)
    if (!res.ok) throw new Error(`Tencent quote HTTP ${res.status} for ${symbol}`)
    const text = await res.text()
    const { fundamentals } = parseTencentQuote(text, symbol)
    return fundamentals
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.marketData.register(new CnMarketProvider(config.id, config.eastmoneyBaseURL, config.sinaBaseURL, config.tencentBaseURL)))
}
