import { describe, expect, it } from "vitest"
import { rsiGrid, rsiGridReport, renderRsiGrid } from "../src/rsi-grid.js"
import { rsi } from "../src/indicators.js"

// open = previous close, so fills at "next open" are easy to check
const bars = (closes: number[]) => closes.map((c, i) => ({ open: i === 0 ? c : closes[i - 1]!, close: c }))

// flat warm-up, a steep slide (RSI pinned low), then a recovery
const slide = [...Array(10).fill(100), 98, 96, 94, 92, 90, 88, 89, 91, 94, 97, 100, 103, 106]
const g = rsiGrid(bars(slide), 7, 30, 60, 10)

describe("rsiGrid (Pine port)", () => {
  it("accumulates (low − rsi) while below low, resets otherwise — exactly the Pine var logic", () => {
    const r = rsi(slide, 7)
    let cum = 0
    slide.forEach((_, i) => {
      const v = r[i]
      cum = v !== null && v !== undefined && v < 30 ? cum + (30 - v) : 0
      expect(g.bars[i]!.cum).toBeCloseTo(cum, 9)
    })
  })

  it("enters on the bar after the condition, at that bar's open", () => {
    const sig = g.bars.findIndex(b => b.signal === "entry")
    expect(sig).toBeGreaterThan(0)
    expect(g.bars[sig]!.cum).toBeGreaterThan(10)
    expect(g.bars[sig + 1]!.entry).toBe(slide[sig])  // next bar's open = signal bar's close
  })

  it("only one position at a time (pyramiding = 1)", () => {
    expect(g.bars.filter(b => b.entry !== undefined)).toHaveLength(1)
  })

  it("closes only when RSI ≥ high AND the position is not at a loss", () => {
    expect(g.trades).toHaveLength(1)
    const t = g.trades[0]!
    const sig = t.exitIndex - 1
    expect(g.bars[sig]!.rsi!).toBeGreaterThanOrEqual(60)
    expect(slide[sig]!).toBeGreaterThanOrEqual(t.entry)
    expect(t.exit).toBe(slide[sig])
  })

  it("holds a losing position even with RSI ≥ high (no stop loss)", () => {
    // slide, then bounce that lifts RSI over 60 while price stays under entry
    // entry fills at 96; the bounce to 90 pushes RSI7 over 60 while still under cost
    const c = [...Array(10).fill(100), 96, 92, 88, 84, 80, 76, 72, 68, 64, 60, 66, 72, 78, 84, 90]
    const x = rsiGrid(bars(c), 7, 30, 60, 10)
    const hot = x.bars.findIndex((b, i) => i > 20 && b.rsi !== null && b.rsi >= 60)
    expect(hot).toBeGreaterThan(0)
    expect(x.trades).toHaveLength(0)
    expect(x.open).not.toBeNull()
    const line = renderRsiGrid(rsiGridReport(bars(c)))
    expect(line).toContain("浮亏中不会平仓")
    expect(line).toContain("无止损")
  })
})
