import { describe, expect, it } from "vitest"
import { entrySignals, renderSignal, signalReport, signalStatus } from "../src/signal.js"
import type { SignalBar } from "../src/signal.js"

const bar = (i: number, close: number, spread = 1): SignalBar => ({
  time: new Date(Date.UTC(2024, 0, 1) + i * 300_000).toISOString(),
  open: close - 0.2, high: close + spread, low: close - spread, close, volume: 100,
})

// Decline then a rally, both with real pullbacks (a pure ramp pins RSI at 100, which the
// "don't chase" filter rightly blocks). SuperTrend must flip bullish and fire a long.
const series: SignalBar[] = [
  ...Array.from({ length: 120 }, (_, i) => bar(i, 200 - i * 0.5 + 2 * Math.sin(i / 2))),
  ...Array.from({ length: 80 }, (_, i) => bar(120 + i, 140 + i * 0.8 + 3 * Math.sin(i / 1.5), 1.5)),
]

describe("entrySignals", () => {
  it("fires a long after a bullish flip, with stop below entry and targets at 1.5R / 3R", () => {
    const longs = entrySignals(series, 10, 3).filter(s => s.side === "long")
    expect(longs.length).toBeGreaterThan(0)
    const s = longs[0]!
    expect(s.index).toBeGreaterThan(120)
    expect(s.stop).toBeLessThan(s.entry)
    const r = s.entry - s.stop
    expect(s.target1).toBeCloseTo(s.entry + 1.5 * r, 1)
    expect(s.target2).toBeCloseTo(s.entry + 3 * r, 1)
  })

  it("never fires two signals on the same side within the cooldown", () => {
    const sig = entrySignals(series, 10, 3)
    for (let i = 1; i < sig.length; i++) {
      if (sig[i]!.side === sig[i - 1]!.side) expect(sig[i]!.index - sig[i - 1]!.index).toBeGreaterThanOrEqual(6)
    }
  })

  it("is empty when there is not enough history", () => {
    expect(entrySignals(series.slice(0, 20), 60, 4)).toEqual([])
  })
})

describe("signalStatus", () => {
  const s = { index: 0, time: "", side: "long" as const, kind: "flip" as const, entry: 100, stop: 95, target1: 107.5, target2: 115 }
  it("stop wins on a bar that touches both (conservative)", () => {
    expect(signalStatus([bar(0, 100), { ...bar(1, 100), low: 94, high: 116 }], s)).toBe("stopped")
  })
  it("tracks T1 then T2", () => {
    expect(signalStatus([bar(0, 100), { ...bar(1, 107, 1), high: 108 }], s)).toBe("target1")
    expect(signalStatus([bar(0, 100), { ...bar(1, 107, 1), high: 108 }, { ...bar(2, 114), high: 115.5 }], s)).toBe("target2")
  })
})

describe("signalReport / renderSignal", () => {
  it("reports the latest signal in Chinese with its rules", () => {
    const text = renderSignal(signalReport(series, 10, 3))
    expect(text).toContain("Signal [")
    expect(text).toMatch(/做多|做空|近期无信号/)
  })
})
