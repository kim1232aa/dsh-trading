import { describe, expect, it } from "vitest"
import { rsiGrid, formingLastIndex } from "../src/rsi-grid.js"
import { rsi } from "../src/indicators.js"

// closes 10,11,10,12,11,13; open = previous close
const closes = [10, 11, 10, 12, 11, 13]
const bars = closes.map((c, i) => ({ open: i === 0 ? c : closes[i - 1]!, close: c }))

describe("RSI 累计差值 vs hand-computed Pine ta.rsi (Wilder RMA, SMA seed)", () => {
  it("RSI(2) matches hand values, na during warm-up", () => {
    const r = rsi(closes, 2)
    expect(r[0]).toBeNull(); expect(r[1]).toBeNull()
    expect(r[2]).toBeCloseTo(50, 9)            // seed: avgG=.5 avgL=.5
    expect(r[3]).toBeCloseTo(100 - 100 / 6, 9) // avgG=1.25 avgL=.25
    expect(r[4]).toBeCloseTo(50, 9)            // .625/.625
    expect(r[5]).toBeCloseTo(100 - 100 / 5.2, 9) // 1.3125/.3125
  })
  it("var cum adds (low-rsi) below low, resets otherwise, 0 on na RSI", () => {
    const g = rsiGrid(bars, 2, 60, 70, 5)
    expect(g.bars.map(b => +b.cum.toFixed(6))).toEqual([0, 0, 10, 0, 10, 0])
  })
  it("entry gated by cum>threshold; exit by rsi>=high and not openprofit<0", () => {
    const g = rsiGrid(bars, 2, 60, 70, 5)
    expect(g.bars[2]!.signal).toBe("entry")
    expect(g.bars[3]!.entry).toBe(10)          // fills next open
    expect(g.bars[3]!.signal).toBe("exit")     // close 12 >= entry 10
    expect(g.bars[4]!.exit).toBe(12)
    expect(g.bars[4]!.signal).toBe("entry")    // cum 10 > 5, flat again
    expect(g.open).toEqual({ entryIndex: 5, entry: 11, side: "long" })
    expect(rsiGrid(bars, 2, 60, 70, 10).bars.some(b => b.signal)).toBe(false) // 10 > 10 is false
  })
  it("closedOnly: the forming last bar never fires a signal", () => {
    const t = closes.map((_, i) => i * 60_000)
    const tb = bars.map((b, i) => ({ ...b, timestamp: t[i]! }))
    const now = t[5]! + 30_000
    expect(formingLastIndex(tb, now)).toBe(5)
    const b2 = tb.slice(0, 5) // last = bar 4 (entry signal) forming
    const g = rsiGrid(b2, 2, 60, 70, 5, "long", { closedOnly: true, nowMs: t[4]! + 1 })
    expect(g.bars[4]!.signal).toBeUndefined()
    expect(g.bars[4]!.provisional).toBe(true)
    const g2 = rsiGrid(b2, 2, 60, 70, 5, "long", { closedOnly: true, nowMs: t[4]! + 60_000 })
    expect(g2.bars[4]!.signal).toBe("entry")
  })
})
