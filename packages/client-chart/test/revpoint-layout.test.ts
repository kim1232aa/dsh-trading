import { describe, expect, it } from "vitest"
import { statusTableRect, clampLabelBox, layoutEdgeTags, clipExtendX, PRICE_AXIS_GAP } from "../src/client/indicators/revpoint-layout.js"

describe("statusTableRect", () => {
  it("pins to top-right and leaves the price axis clear", () => {
    const r = statusTableRect(1000, 240, 180)
    expect(r).toEqual({ x: 1000 - 240 - PRICE_AXIS_GAP, y: 8, w: 240, h: 180 })
    expect(r.x + r.w).toBeLessThanOrEqual(1000 - PRICE_AXIS_GAP)
  })
})

describe("clampLabelBox", () => {
  it("clamps a partially off-left label into the pane", () => {
    expect(clampLabelBox(-20, 50, 80, 30, 800, 400)).toEqual({ x: 0, y: 50 })
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
      expect(p.x + 110).toBeLessThanOrEqual(table.x)
      expect(p.x).toBeGreaterThanOrEqual(0)
    }
    // vertical collision resolved
    expect(out[1]!.y).toBeGreaterThanOrEqual(out[0]!.y + 16)
  })
  it("stacks colliding tags without the table", () => {
    const out = layoutEdgeTags([{ y: 100, w: 80, h: 16 }, { y: 100, w: 80, h: 16 }], 800, 400, null)
    expect(out[0]!.y).not.toEqual(out[1]!.y)
    expect(Math.abs(out[0]!.y - out[1]!.y)).toBeGreaterThanOrEqual(16)
  })
})

describe("clipExtendX", () => {
  it("stops a right-extending ray at the pane edge", () => {
    expect(clipExtendX(100, 5000, 900)).toBe(900)
    expect(clipExtendX(100, 800, 900)).toBe(800)
  })
})
