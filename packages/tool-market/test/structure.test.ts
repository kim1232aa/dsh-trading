import { afterEach, describe, expect, it, vi } from "vitest"
import { priceStructure, renderStructure } from "../src/structure.js"
import { reachedT1, renderSignal } from "../src/signal.js"
import { closestSymbol, normalizeSymbol, okxDerivatives, postureOf } from "../../provider-binance/src/index.js"

describe("symbol normalization and typo tolerance", () => {
  const list = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"]

  it("normalizes base coins and fixes quote slips", () => {
    expect(normalizeSymbol("eth")).toBe("ETHUSDT")
    expect(normalizeSymbol("ETHUDST")).toBe("ETHUSDT")
    expect(normalizeSymbol("ETHUSTD")).toBe("ETHUSDT")
    expect(normalizeSymbol("btc_udst")).toBe("BTCUSDT")
    expect(normalizeSymbol("SOL/USDT")).toBe("SOLUSDT")
    // real quotes ending in USD must not be "corrected"
    expect(normalizeSymbol("ETHBUSD")).toBe("ETHBUSD")
    expect(normalizeSymbol("BTCFDUSD")).toBe("BTCFDUSD")
    expect(closestSymbol("ETHUSD", list)).toBe("ETHUSDT")
  })

  it("suggests the intended symbol for a typo, nothing for an unrelated one", () => {
    expect(closestSymbol("EHTUSDT", list)).toBe("ETHUSDT")
    expect(closestSymbol("ETHUDST", list)).toBe("ETHUSDT")
    expect(closestSymbol("SOLUSTD", list)).toBe("SOLUSDT")
    expect(closestSymbol("PEPEUSDT", list)).toBeNull()
  })
})

const mk = (lows: number[], vol = 100) => lows.map((l, i) => ({
  time: new Date(Date.UTC(2026, 0, 1, 0, i * 5)).toISOString(),
  high: l + 4, low: l, close: l + 2, volume: vol,
}))

describe("priceStructure", () => {
  // zigzag with descending peaks and troughs
  const path = [120, 118, 116, 114, 116, 118, 117, 115, 112, 110, 112, 114, 113, 111, 108, 106, 108, 110, 109, 108, 107]
  const s = priceStructure(mk(path))

  it("labels lower highs and lower lows as a down structure", () => {
    expect(s.lows.map(x => x.price)).toEqual([114, 110, 106])
    expect(s.lows.at(-1)!.label).toBe("LL")
    expect(s.highs.at(-1)!.label).toBe("LH")
    expect(s.trend).toBe("down")
  })

  it("treats separated equal lows as EQ (double bottom)", () => {
    const d = priceStructure(mk([110, 108, 106, 104, 106, 108, 106, 104, 106, 108, 110, 112]))
    expect(d.lows.map(x => x.label)).toEqual([null, "EQ"])
  })

  it("flags price beyond the last confirmed low before a new pivot can confirm", () => {
    // rising pivots, then a crash in the last bars (too recent to confirm a pivot)
    const b = priceStructure(mk([100, 102, 104, 106, 104, 102, 104, 106, 108, 110, 108, 106, 108, 110, 112, 114, 112, 110, 108, 95, 94]))
    expect(b.trend).toBe("up")
    expect(b.breakOut).toContain("已跌破前低 106")
    expect(renderStructure(b)).toContain("结构待确认")
  })

  it("flags a volume spike against the prior median", () => {
    const bars = mk(Array(40).fill(100))
    bars[39]!.volume = 4000
    const v = priceStructure(bars).volume
    expect(v.lastRatio).toBe(40)
    expect(v.peakTime).toBe(bars[39]!.time)
    expect(renderStructure(priceStructure(bars))).toContain("最新根 40×中位数")
  })

  it("reports bullish divergence when price makes a lower low on higher RSI", () => {
    // long slide into the first low, then a shallow bounce and a marginal new low
    const slide = Array.from({ length: 30 }, (_, i) => 200 - i * 3)
    const bars = mk([...slide, 115, 118, 121, 120, 119, 118, 117, 112, 115, 118, 121, 124])
    const st = priceStructure(bars)
    expect(st.divergence.some(d => d.startsWith("底背离"))).toBe(true)
  })

  it("detects valid trendlines and renders them into structure text", () => {
    const st = priceStructure(mk([120, 118, 116, 114, 116, 118, 117, 115, 112, 110, 112, 114, 113, 111, 108, 106, 108, 110, 109, 108, 107]))
    expect(st.trendlines.length).toBeGreaterThan(0)
    const downLine = st.trendlines.find(t => t.direction === 'down')
    expect(downLine).toBeDefined()
    expect(downLine?.touches).toBeGreaterThanOrEqual(2)
    const rendered = renderStructure(st)
    expect(rendered).toContain("趋势线:")
    expect(rendered).toContain("下行压力")
  })
})

describe("reachedT1", () => {
  const s = { index: 0, time: "", side: "long" as const, kind: "flip" as const, entry: 100, stop: 95, target1: 107.5, target2: 115 }
  const bar = (high: number, low: number) => ({ time: "", open: 100, high, low, close: 100, volume: 1 })
  it("counts a trade that tagged T1 and later stopped as a T1 hit", () => {
    expect(reachedT1([bar(100, 100), bar(108, 101), bar(101, 94)], s)).toBe(true)
  })
  it("same bar hitting stop and T1 resolves to the stop", () => {
    expect(reachedT1([bar(100, 100), bar(108, 94)], s)).toBe(false)
  })
  it("prints expectancy and a small-sample warning", () => {
    const line = renderSignal({ latest: null, trend: null, blockers: [], record: { finished: 10, hitT1: 4 } })
    expect(line).toContain("期望 0.00R/笔")
    expect(line).toContain("样本<30不可信")
  })
})

describe("postureOf", () => {
  it("maps the price × OI quadrant without claiming who traded", () => {
    expect(postureOf(-0.5, -1.0, true)).toBe("价跌减仓 (多头平仓为主)")
    expect(postureOf(-0.5, 1.0, true)).toBe("价跌增仓 (空头增仓为主)")
    expect(postureOf(0.1, -0.1, false)).toBe("空头回补")
    expect(postureOf(0.1, 0.1, false)).toBe("多头增仓")
  })
  it("treats moves inside the dead zone as no signal", () => {
    // the reported case: BTC OI −1.47%, price −0.30% → real 多头平仓; but ETH OI +0.07%, price −0.20% → flat
    expect(postureOf(-0.30, -1.47, true)).toBe("价跌减仓 (多头平仓为主)")
    expect(postureOf(-0.20, 0.07, true)).toBe("持仓持平")
    expect(postureOf(0.05, -0.8, true)).toBe("价平减仓")
  })
})

describe("okxDerivatives", () => {
  afterEach(() => { vi.unstubAllGlobals() })
  it("reads taker rows as [ts, sell, buy] and derives posture from price x OI, not OI alone", async () => {
    // OI +2% over the hour while implied price (oiUsd / oiCcy) falls 1%: shorts opening, never "偏多"
    const oihRows = Array.from({ length: 13 }, (_, i) => {
      const ccy = i === 0 ? 102 : 100
      const px = i === 0 ? 2970 : 3000
      return [String(1_790_000_000_000 - i * 300_000), String(ccy * 10), String(ccy), String(ccy * px)]
    })
    // longer keys first: "open-interest" is a substring of "open-interest-history"
    const bodies: Record<string, unknown> = {
      "open-interest-history": oihRows,
      "open-interest": [{ oi: "1020", oiCcy: "102", oiUsd: "302940", ts: "1790965584103" }],
      "funding-rate": [{ fundingRate: "0.0001", nextFundingTime: "1790985600000" }],
      "top-trader": [["1790971800000", "0.92"]],
      "taker-volume-contract": [["1790971500000", "200", "100"]],
    }
    vi.stubGlobal("fetch", async (url: URL) => {
      const key = Object.keys(bodies).find(k => String(url).includes(k))
      return new Response(JSON.stringify(key ? { code: "0", data: bodies[key] } : { code: "404" }), { status: key ? 200 : 404 })
    })
    const d = await okxDerivatives("ETHUSDT")
    expect(d.takerBuySellRatio).toBe(0.5)
    expect(d.oiChangePct1h).toBe(2)
    expect(d.priceChangePct1h).toBe(-1)
    expect(d.posture).toBe("价跌增仓 (空头增仓为主)")
    expect(d.topPositionRatio).toBe(0.92)
  })
})
