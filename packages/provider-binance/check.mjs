// Live self-check: node check.mjs  (needs network)
import assert from 'node:assert/strict'
import { apply } from './lib/index.js'

let provider
apply({ effect: f => f(), marketData: { register: p => { provider = p; return () => {} } } },
  { symbols: ['ETHUSDT'], baseURL: 'https://data-api.binance.vision', futuresURL: 'https://fapi.binance.com', id: 'binance' })

const bars = await provider.getOhlcv({ symbol: 'ETHUSDT', timeframe: '15m', limit: 5 })
assert.equal(bars.length, 5)
for (const b of bars) {
  assert.ok(b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close), 'OHLC sane')
  assert.ok(!Number.isNaN(Date.parse(b.time)))
}
assert.ok(Date.parse(bars[1].time) - Date.parse(bars[0].time) === 15 * 60e3, '15m spacing')
console.log('ok', bars.at(-1))

const d = await provider.getDerivatives('ETHUSDT')
assert.ok(['Binance', 'Gate'].includes(d.source), `source: ${d.source}`)
for (const k of ['openInterest', 'openInterestValue', 'fundingRate', 'longShortRatio', 'takerBuySellRatio']) {
  assert.ok(Number.isFinite(d[k]), `${k} is a number: ${d[k]}`)
}
assert.ok(d.openInterest > 0 && d.openInterestValue > d.openInterest, 'OI value = OI × mark')
assert.ok(Math.abs(d.fundingRate) < 0.01, 'funding is a fraction, not a percent')
assert.ok(Date.parse(d.nextFundingTime) > Date.now() - 60e3, 'next funding is upcoming')
// Either venue may answer first (Binance futures is unreachable from some networks).
await assert.rejects(provider.getDerivatives('NOTAREALPAIR'), /futures 400|no USDT perpetual|timeout|aborted/i)
console.log('ok', d)

// Fallback leg on its own: point Binance at a dead port, Gate must answer.
let dead
apply({ effect: f => f(), marketData: { register: p => { dead = p; return () => {} } } },
  { symbols: ['ETHUSDT'], baseURL: 'https://data-api.binance.vision', futuresURL: 'http://127.0.0.1:9', id: 'binance' })
const g = await dead.getDerivatives('ETHUSDT')
assert.equal(g.source, 'Gate')
for (const k of ['openInterest', 'openInterestValue', 'fundingRate', 'longShortRatio', 'takerBuySellRatio']) {
  assert.ok(Number.isFinite(g[k]), `gate ${k} is a number: ${g[k]}`)
}
assert.ok(g.openInterestValue > g.openInterest, 'gate OI value in USD > OI in ETH')
assert.ok(Date.parse(g.nextFundingTime) > Date.now() - 60e3, 'gate next funding is upcoming')
console.log('ok gate fallback', g)
