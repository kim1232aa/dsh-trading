import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { rsiGridMarksIndicator } from "../src/client/indicators/rsi-grid.js"

type K = { open: number; high: number; low: number; close: number; timestamp: number }
const raw = JSON.parse(readFileSync(new URL("./fixtures/btcusdt-15m-binance-20261015.json", import.meta.url), "utf8")) as number[][]
const live: K[] = raw.map(([t, o, h, l, c]) => ({ timestamp: t!, open: o!, high: h!, low: l!, close: c! }))
const P = [7, 30, 60, 10]

function mockCtx() {
  const texts: { t: string; x: number }[] = []
  const noop = () => {}
  const ctx = new Proxy({ texts, measureText: (s: string) => ({ width: s.length * 6 }), fillText: (t: string, x: number) => texts.push({ t, x }) } as Record<string, unknown>,
    { get: (o, k) => (k in o ? o[k as string] : noop), set: () => true })
  return ctx as unknown as CanvasRenderingContext2D & { texts: typeof texts }
}
function draw(list: K[], from: number, to: number) {
  const result = rsiGridMarksIndicator.calc(list, { calcParams: P })
  const ctx = mockCtx()
  rsiGridMarksIndicator.draw({ ctx, indicator: { calcParams: P, result }, xAxis: { convertToPixel: i => i * 10 }, yAxis: { convertToPixel: v => v / 100 },
    visibleRange: { from, to }, bounding: { width: 20000 }, kLineDataList: list })
  return { ctx, result }
}

describe("RSI网格 candle markers (P0 recheck, live BTCUSDT 15m fixture)", () => {
  it("entry condition on a closed bar → RSI多头 marker at the FILL bar (next open)", () => {
    const { ctx, result } = draw(live, 0, live.length)
    const iso = (i: number) => new Date(live[i]!.timestamp + 9 * 3600e3).toISOString().slice(5, 16)
    const fills = result.map((r, i) => (r.entry !== undefined ? i : -1)).filter(i => i >= 0)
    expect(fills.map(iso)).toEqual(["10-05T13:30", "10-06T01:15", "10-06T15:15", "10-07T11:00"])
    for (const i of fills) {
      expect(result[i - 1]!.signal).toBe("entry")            // signal on the previous closed bar
      expect(result[i]!.entry).toBe(live[i]!.open)            // filled at this bar's open
      expect(ctx.texts.some(t => t.t.startsWith("RSI多头") && Math.abs(t.x - i * 10) <= 60)).toBe(true)
    }
    expect(ctx.texts.some(t => t.t === "RSI多头 84391.49")).toBe(true)
  })
  it("diagnosis: later 累计差值 spikes >10 add no marker — position from 10-07 11:00 @84391.49 is held underwater (pyramiding=1, no exit at a loss)", () => {
    const { ctx, result } = draw(live, 900, live.length)       // recent window only
    const spikes = result.map((r, i) => (i >= 900 && r.cum > 10 ? i : -1)).filter(i => i >= 0)
    expect(spikes.length).toBeGreaterThan(0)
    for (const i of spikes) { expect(result[i]!.signal).toBeUndefined(); expect(result[i]!.inPos).toBe(true) }
    expect(result.at(-1)!.posEntry).toBe(84391.49)
    expect(ctx.texts.some(t => t.t.startsWith("RSI多头"))).toBe(false)
    expect(ctx.texts.some(t => t.t.startsWith("RSI网格持多 @84391.49"))).toBe(true)  // cost line explains it
  })
})
