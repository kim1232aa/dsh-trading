import { describe, expect, it } from "vitest"
import { statusTableRect, clampLabelBox, layoutEdgeTags, clipExtendX, tableMode, PRICE_AXIS_GAP } from "../src/client/indicators/revpoint-layout.js"

describe("statusTableRect", () => {
  it("pins to top-right and leaves the price axis clear", () => {
    const r = statusTableRect(1000, 240, 180)
    expect(r).toEqual({ x: 1000 - 240 - PRICE_AXIS_GAP, y: 8, w: 240, h: 180 })
    expect(r.x + r.w).toBeLessThanOrEqual(1000 - PRICE_AXIS_GAP)
  })
})

describe("clampLabelBox", () => {
  it("hides a label with ANY significant horizontal overflow (no '52.00 顺1H' fragments)", () => {
    expect(clampLabelBox(-20, 50, 80, 30, 800, 400)).toBeNull()
    expect(clampLabelBox(760, 50, 80, 30, 800, 400)).toBeNull()
    expect(clampLabelBox(-1, 50, 80, 30, 800, 400)).toEqual({ x: 0, y: 50 })  // 2px slack
  })
  it("clamps vertically", () => {
    expect(clampLabelBox(100, -10, 80, 30, 800, 400)).toEqual({ x: 100, y: 0 })
  })
  it("hides a label whose anchor is mostly off-screen (truncated ◆大顶)", () => {
    expect(clampLabelBox(-90, 50, 100, 30, 800, 400)).toBeNull()
    expect(clampLabelBox(-200, 50, 100, 30, 800, 400)).toBeNull()
  })
  it("keeps an on-screen label put", () => {
    expect(clampLabelBox(100, 50, 80, 30, 800, 400)).toEqual({ x: 100, y: 50 })
  })
})

describe("layoutEdgeTags", () => {
  it("places tags left of the table so prefixes stay visible", () => {
    const table = statusTableRect(1000, 240, 180)
    const tags = [
      { y: 40, w: 110, h: 16 },   // would sit inside the table band
      { y: 60, w: 110, h: 16 },
      { y: 300, w: 110, h: 16 },
    ]
    const out = layoutEdgeTags(tags, 1000, 500, table)
    for (const p of out) {
      expect(p).not.toBeNull()
      const hitsTable = p!.x < table.x + table.w && p!.x + 110 > table.x && p!.y < table.y + table.h && p!.y + 16 > table.y
      expect(hitsTable).toBe(false)
      expect(p!.x).toBeGreaterThanOrEqual(0)
    }
    expect(Math.abs(out[1]!.y - out[0]!.y) >= 16 || Math.abs(out[1]!.x - out[0]!.x) >= 110).toBe(true)
  })
  it("stacks colliding tags without the table", () => {
    const out = layoutEdgeTags([{ y: 100, w: 80, h: 16 }, { y: 100, w: 80, h: 16 }], 800, 400, null)
    expect(Math.abs(out[0]!.y - out[1]!.y)).toBeGreaterThanOrEqual(16)
  })
  it("short pane: drops lowest-priority tags first instead of overlapping", () => {
    const tags = Array.from({ length: 6 }, (_, i) => ({ y: 30, w: 80, h: 16, priority: i }))
    const out = layoutEdgeTags(tags, 800, 60, null)
    const kept = out.map((p, i) => (p ? i : -1)).filter(i => i >= 0)
    expect(kept.length).toBeLessThan(6)
    expect(kept).toContain(5)           // highest priority survives
    expect(out[0]).toBeNull()           // lowest dropped
  })
  it("table mode adapts to pane height (指标参数 open → ~174px)", () => {
    expect(tableMode(500, 180)).toBe("full")
    expect(tableMode(174, 180)).toBe("compact")
    expect(tableMode(90, 180)).toBe("hidden")
  })
})

describe("clipExtendX", () => {
  it("stops a right-extending ray at the pane edge", () => {
    expect(clipExtendX(100, 5000, 900)).toBe(900)
    expect(clipExtendX(100, 800, 900)).toBe(800)
  })
})
