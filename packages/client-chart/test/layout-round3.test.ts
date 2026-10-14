import { describe, expect, it } from "vitest"
import { layoutEdgeTags, statusTableRect, rectsOverlap, ohlcOffsetRightForTopLeft } from "../src/client/indicators/revpoint-layout.js"
import { clampLabelX, costLabelX, RSI_AXIS_MIN, RSI_AXIS_MAX, rsiGridIndicator } from "../src/client/indicators/rsi-grid.js"
import { ohlcTooltipAvoidTable } from "../src/client/ChartCard.js"

describe("round-3 layout", () => {
  it("edge tags never intersect the table at any zoom (fuzz)", () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let run = 0; run < 300; run++) {
      const W = 400 + rnd() * 1200, H = 120 + rnd() * 600
      const table = statusTableRect(W, 216, rnd() < 0.5 ? 180 : 36)
      const tags = Array.from({ length: 1 + Math.floor(rnd() * 11) }, (_, i) => ({ y: rnd() * H, w: 70 + rnd() * 60, h: 16, priority: i % 6 }))
      const out = layoutEdgeTags(tags, W, H, table)
      out.forEach((p, i) => { if (p) expect(rectsOverlap({ x: p.x, y: p.y, w: tags[i]!.w, h: tags[i]!.h }, table)).toBe(false) })
      // tags don't overlap each other either
      for (let a = 0; a < out.length; a++) for (let b = a + 1; b < out.length; b++) {
        const A = out[a], B = out[b]
        if (A && B) expect(rectsOverlap({ ...A, w: tags[a]!.w, h: 16 }, { ...B, w: tags[b]!.w, h: 16 })).toBe(false)
      }
    }
  })
  it("zoomed into last bars: ↓趋 / 1H S / 4H S levels inside the table band still avoid it", () => {
    const table = statusTableRect(700, 216, 180)
    const ys = [100, 110, 120, 130, 150]  // all within the table's vertical band
    const out = layoutEdgeTags(ys.map((y, i) => ({ y, w: 110, h: 16, priority: i })), 700, 431, table)
    out.forEach(p => { if (p) expect(rectsOverlap({ ...p, w: 110, h: 16 }, table)).toBe(false) })
  })
  it("OHLC box parks top-left when RevPoint is on (both crosshair halves)", () => {
    const W = 900, boxW = 180
    const off = ohlcOffsetRightForTopLeft(W)
    const rectX = W - off - boxW - 4   // klinecharts right-parked x
    expect(rectX).toBeLessThan(40)
    expect(rectX).toBeGreaterThanOrEqual(0)
    expect(ohlcTooltipAvoidTable(false, W)).toEqual({ candle: { tooltip: { rect: { offsetRight: 4 } } } })
  })
  it("cost-line label anchors right before the price axis; left of the table inside its band", () => {
    const W = 900, t = statusTableRect(W, 216, 180)
    expect(costLabelX(300, 400, W)).toBe(W - 8 - 300)
    expect(costLabelX(300, 100, W) + 300).toBeLessThanOrEqual(t.x)
  })
  it("RSI多头/平仓 labels clamp inside the pane", () => {
    expect(clampLabelX(0, 100, 800)).toBe(52)
    expect(clampLabelX(800, 100, 800)).toBe(748)
    expect(clampLabelX(300, 100, 800)).toBe(300)
  })
  it("RSI axis padded beyond 0–100", () => {
    expect(rsiGridIndicator.minValue).toBe(RSI_AXIS_MIN)
    expect(RSI_AXIS_MIN).toBeLessThan(0)
    expect(RSI_AXIS_MAX).toBeGreaterThan(100)
  })
})
