import { describe, expect, it } from "vitest"
import { rsiDiffReport, rsiDiffSeries, renderRsiDiff } from "../src/rsi-diff.js"

describe("rsiDiff", () => {
  it("computes rsi(6) - rsi(12) difference series", () => {
    // Sharp dip then strong recovery: fast RSI bounces much faster than slow RSI
    const down = Array.from({ length: 20 }, (_, i) => 100 - i * 2)
    const bounce = [65, 75, 88, 105, 120]
    const closes = [...down, ...bounce]
    const diffs = rsiDiffSeries(closes, 6, 12)
    expect(diffs).toHaveLength(closes.length)
    const lastDiff = diffs[diffs.length - 1]
    expect(lastDiff).not.toBeNull()
    expect(lastDiff!).toBeGreaterThan(0)
  })

  it("identifies golden cross and overbought/oversold tags", () => {
    // Sharp decline followed by a sharp bounce
    const down = Array.from({ length: 20 }, (_, i) => 200 - i * 5)
    const bounce = [105, 115, 130, 150, 170]
    const closes = [...down, ...bounce]
    const report = rsiDiffReport(closes, 6, 12)

    expect(report.rsi6).not.toBeNull()
    expect(report.rsi12).not.toBeNull()
    expect(report.diff).not.toBeNull()
    expect(report.lastCross).not.toBeNull()
    expect(report.lastCross?.type).toBe("golden")
    expect(["超卖金叉", "金叉"]).toContain(report.lastCross?.tag)
  })

  it("identifies death cross after a rally", () => {
    const up = Array.from({ length: 25 }, (_, i) => 100 + i * 4)
    const dump = [190, 175, 155, 135]
    const closes = [...up, ...dump]
    const report = rsiDiffReport(closes, 6, 12)

    expect(report.lastCross).not.toBeNull()
    expect(report.lastCross?.type).toBe("death")
    expect(["超买死叉", "死叉"]).toContain(report.lastCross?.tag)
  })

  it("renders human readable Chinese status text", () => {
    const text = renderRsiDiff({
      rsi6: 28.5,
      rsi12: 36.2,
      diff: -7.7,
      dominance: "bearish",
      momentum: "expanding",
      lastCross: { type: "death", barsAgo: 3, tag: "死叉" },
    })
    expect(text).toContain("RSI快慢差 (6-12)")
    expect(text).toContain("空头占优·动能扩张")
    expect(text).toContain("3根前死叉")
  })
})
