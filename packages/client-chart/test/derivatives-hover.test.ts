import { describe, expect, it } from 'vitest'
import { derivativesForTime } from '../src/client/market-client.js'
import type { PanelDerivatives } from '../src/client/market-client.js'

const live: PanelDerivatives = {
  source: 'Binance', time: '2026-10-15T01:00:00Z',
  openInterest: 99, openInterestValue: 9900, fundingRate: 0.0001, nextFundingTime: null,
  longShortRatioKind: 'global_accounts', longShortRatio: 2.05,
  topPositionRatio: 0.93, topAccountRatio: 1.40, takerBuySellRatio: 1.8,
  readings: [{ id: 'accounts', label: 'LIVE', note: '', tone: 'neutral' }],
  history: [{
    time: '2026-10-15T00:00:00Z', openInterest: 50, openInterestValue: 5000,
    longShortRatio: 1.2, topPositionRatio: 0.8, topAccountRatio: null, takerBuySellRatio: null,
    readings: [{ id: 'accounts', label: 'HISTORICAL', note: '', tone: 'neutral' }],
  }],
}

describe('derivative strip crosshair selection', () => {
  it('keeps the live snapshot when there is no crosshair', () => {
    expect(derivativesForTime(live, null, 60_000)).toBe(live)
  })
  it.each([{ name: 'empty history', history: [] }, { name: 'outside history', history: live.history ?? [] }])('shows missing data instead of live ratios: $name', ({ history }) => {
    const view = derivativesForTime({ ...live, history }, Date.parse('2026-10-14T23:00:00Z'), 60_000)
    expect(view).toMatchObject({
      isHistorical: true, time: '2026-10-14T23:00:00.000Z',
      openInterest: null, longShortRatio: null, topPositionRatio: null, topAccountRatio: null,
      takerBuySellRatio: null, readings: [],
    })
  })
  it('uses historical readings and source kind without filling missing fields from live', () => {
    const view = derivativesForTime(live, Date.parse('2026-10-15T00:01:00Z'), 60_000)
    expect(view).toMatchObject({
      isHistorical: true, longShortRatio: 1.2, topPositionRatio: 0.8, topAccountRatio: null,
      longShortRatioKind: 'global_accounts', readings: [{ label: 'HISTORICAL' }],
    })
  })
})
