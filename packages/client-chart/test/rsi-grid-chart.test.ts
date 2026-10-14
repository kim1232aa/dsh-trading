import { describe, expect, it } from "vitest"
import { rsiGridIndicator, rsiGridCumIndicator, rsiGridMarksIndicator } from "../src/client/indicators/rsi-grid.js"
import { revPointIndicator } from "../src/client/indicators/revpoint.js"

describe("RSI 网格 chart split (Pine layout)", () => {
  it("RSI pane is fixed 0–100 and carries only RSI; cum has its own pane", () => {
    expect(rsiGridIndicator.minValue).toBeLessThan(0)
    expect(rsiGridIndicator.maxValue).toBeGreaterThan(100)
    expect(rsiGridIndicator.figures.map(f => f.key)).toEqual(["rsi"])
    expect(rsiGridCumIndicator.figures.map(f => f.key)).toEqual(["cum"])
  })
  it("entry/exit markers are a price-series (candle pane) indicator", () => {
    expect(rsiGridMarksIndicator.series).toBe("price")
    const t0 = Date.UTC(2026, 0, 1)
    const closes = [10, 11, 10, 12, 11, 13]
    const list = closes.map((c, i) => ({ open: i ? closes[i - 1]! : c, high: c, low: c, close: c, timestamp: t0 + i * 60_000 }))
    const rows = rsiGridMarksIndicator.calc(list, { calcParams: [2, 60, 70, 5] })
    expect(rows[3]!.entry).toBe(10)
    expect(rows[4]!.exit).toBe(12)
  })
  it("RevPoint overlay computes on the candle pane", () => {
    expect(revPointIndicator.series).toBe("price")
    const t0 = Date.UTC(2026, 0, 1)
    const list = [100, 100.3, 100.6, 101, 100.7, 100.4, 100.2, 100.3].map((c, i) => ({ open: c, high: c, low: c, close: c, volume: 1, timestamp: t0 + i * 300_000 }))
    const rp = revPointIndicator.calc(list, { calcParams: [0.7, 2, 3, 0, 0, 1, 0, 1, 0] })[0]!.rp!
    expect(rp.fine[0]).toMatchObject({ idx: 3, isTop: true })
  })
})
