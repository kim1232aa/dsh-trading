/**
 * Live provider + tool harness (no LLM). Run from repo root:
 *   node scripts/real-harness.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CnMarketProvider } from '../packages/provider-cn/lib/index.js'
import { apply as applyBinance, isBinanceSymbol } from '../packages/provider-binance/lib/index.js'
import { apply as applyTools } from '../packages/tool-market/lib/index.js'
import { apply as applyHoldings } from '../packages/holdings/lib/index.js'
import { apply as applyWatchlist } from '../packages/watchlist/lib/index.js'
import { apply as applyAuthority } from '../packages/authority/lib/index.js'
import { apply as applyTasks } from '../packages/tasks-schedule/lib/index.js'

const root = '/tmp/dsh-trading-real-harness'
mkdirSync(join(root, 'data/holdings'), { recursive: true })
mkdirSync(join(root, 'charts'), { recursive: true })

class MarketDataHub {
  constructor(defaultId = 'csv') {
    this.providers = new Map()
    this.defaultId = defaultId
  }
  register(p) {
    this.providers.set(p.id, p)
    return () => this.providers.delete(p.id)
  }
  list() { return [...this.providers.keys()] }
  provider(id) {
    if (id) {
      const p = this.providers.get(id)
      if (!p) throw new Error(`unknown provider ${id}`)
      return p
    }
    if (this.defaultId) return this.provider(this.defaultId)
    if (this.providers.size === 1) return [...this.providers.values()][0]
    throw new Error(`several providers: ${this.list()}`)
  }
  resolveProvider(symbol, explicitId) {
    if (explicitId) return this.provider(explicitId)
    if (symbol) {
      for (const p of this.providers.values()) {
        try { if (p.matchesSymbol?.(symbol)) return p } catch {}
      }
    }
    return this.provider()
  }
}

const marketData = new MarketDataHub('csv')
marketData.register({
  id: 'csv',
  description: 'fixture',
  listSymbols: async () => [{ symbol: 'DEMO-EQ', timeframes: ['1d'] }],
  getOhlcv: async () => {
    const bars = []
    let px = 100
    for (let i = 0; i < 80; i++) {
      px += Math.sin(i / 5)
      bars.push({
        time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        open: px, high: px + 1, low: px - 1, close: px + 0.2, volume: 1000,
      })
    }
    return bars
  },
})
marketData.register(new CnMarketProvider('cn', 'https://push2his.eastmoney.com', 'https://quotes.sina.cn', 'https://qt.gtimg.cn', 10000))

const toolMap = new Map()
const fakeCtx = {
  marketData,
  tools: {
    register(tool) { toolMap.set(tool.name, tool); return () => toolMap.delete(tool.name) },
  },
  effect(fn) { return fn() },
  get(name) { return name === 'marketData' ? marketData : undefined },
}

applyBinance(fakeCtx, {
  id: 'binance',
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'],
  baseURL: 'https://data-api.binance.vision',
  futuresURL: 'https://fapi.binance.com',
})
applyTools(fakeCtx, { chartDir: join(root, 'charts') })
applyHoldings(fakeCtx, { storeDir: join(root, 'data/holdings') })
applyWatchlist(fakeCtx, { storePath: join(root, 'data/watchlist.json') })
applyAuthority(fakeCtx, { grantPath: join(root, 'data/live-trading.grant.json') })
applyTasks(fakeCtx, {
  tasksFilePath: join(root, 'data/tasks.json'),
  logsFilePath: join(root, 'data/task-logs.json'),
})

const report = []
async function run(name, args) {
  const tool = toolMap.get(name)
  if (!tool) { report.push({ name, ok: false, detail: 'missing tool' }); return }
  try {
    const out = await tool.execute(args, {})
    const rendered = tool.output?.render?.(args, out)
    const text = Array.isArray(rendered)
      ? rendered.map(x => x.text).filter(Boolean).join('\n')
      : JSON.stringify(out)
    report.push({ name: `${name} ${JSON.stringify(args).slice(0, 90)}`, ok: true, detail: String(text).slice(0, 600) })
    return out
  } catch (e) {
    report.push({ name: `${name} ${JSON.stringify(args).slice(0, 90)}`, ok: false, detail: String(e).slice(0, 400) })
  }
}

console.log('providers', marketData.list())
console.log('resolve BTCUSDT ->', marketData.resolveProvider('BTCUSDT').id)
console.log('resolve 600519 ->', marketData.resolveProvider('600519').id)
console.log('resolve DEMO-EQ ->', marketData.resolveProvider('DEMO-EQ').id)
console.log('isBinanceSymbol(600519)', isBinanceSymbol('600519'))
console.log('tools', [...toolMap.keys()].sort().join(', '))

await run('list_symbols', { provider: 'binance' })
await run('list_symbols', { provider: 'cn' })
await run('market_snapshot', { symbol: 'BTCUSDT', timeframes: ['1h'], bars: 100 })
await run('market_snapshot', { symbol: '600519', timeframes: ['1d'], bars: 100 })
await run('get_ohlcv', { symbol: 'ETHUSDT', timeframe: '15m', limit: 20 })
await run('get_ohlcv', { symbol: '000001', timeframe: '1d', limit: 15 })
await run('get_holdings', {})
await run('add_to_watchlist', { symbol: 'BTCUSDT', group: 'crypto' })
await run('get_watchlist', {})
await run('list_scheduled_tasks', {})
await run('check_trade_authority', { action: 'place_order', symbol: 'BTCUSDT', side: 'buy', quantity: 1 })
await run('screen_market', { pattern: 'bullish_alignment', provider: 'binance' })
await run('find_swing_points', { symbol: 'BTCUSDT', timeframe: '1h', bars: 100 })

let p = 0, f = 0
const lines = ['# dsh-trading real harness', `time: ${new Date().toISOString()}`, '']
for (const r of report) {
  r.ok ? p++ : f++
  console.log(`\n${r.ok ? 'OK' : 'FAIL'}  ${r.name}`)
  console.log('  ' + r.detail.replace(/\n/g, '\n  '))
  lines.push(`## ${r.ok ? 'OK' : 'FAIL'} ${r.name}`)
  lines.push('```')
  lines.push(r.detail)
  lines.push('```')
  lines.push('')
}
lines.push(`passed=${p} failed=${f}`)
writeFileSync('/workspace/shots/trading-real-harness.md', lines.join('\n'))
console.log(`\n==== SUMMARY passed=${p} failed=${f} ====`)
process.exit(f ? 1 : 0)
