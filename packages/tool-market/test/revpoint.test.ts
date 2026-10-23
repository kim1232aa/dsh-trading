import { describe, expect, it } from "vitest"
import { revPoint, revPointReport, renderRevPoint, freezeLine, swingConnect, htfPackSeries, ema1hSeries, resampleClosed, type RpCandle } from "../src/revpoint.js"

const M5 = 300_000
const T0 = Date.UTC(2026, 9, 1)
const mk = (closes: number[], vol = (_: number) => 100): RpCandle[] =>
  closes.map((c, i) => ({ t: T0 + i * M5, open: c, high: c, low: c, close: c, volume: vol(i) }))
const past = { nowMs: T0 + 1e12 }

describe("RevPoint zigzag", () => {
  it("fine top confirms once price falls 0.7% off the high, at the high bar", () => {
    const c = mk([100, 100.3, 100.6, 101, 100.7, 100.4, 100.2])  // 101 → 100.2 = -0.79%
    const r = revPoint(c, [], past)
    expect(r.fine).toHaveLength(1)
    expect(r.fine[0]).toMatchObject({ idx: 3, price: 101, isTop: true, text: "▼" })
    expect(r.candidate!.isTop).toBe(false)
    const r2 = revPoint(mk([100, 100.3, 100.6, 101, 100.5]), [], past)  // only -0.5%
    expect(r2.fine).toHaveLength(0)
    expect(r2.candidate).toMatchObject({ isTop: true, price: 101 })
    expect(r2.candidate!.need).toBeCloseTo(0.7 - 100 * 0.5 / 101, 6)
    expect(r2.candidate!.text).toContain("还差")
  })
  it("coarse tier needs 2% and labels ◆大顶", () => {
    const up = [100, 100.5, 101, 101.5, 102, 102.5, 103, 103.5, 104, 103.5, 103, 102.5, 102]
    expect(revPoint(mk(up), [], past).big).toHaveLength(0)   // 1.92% < 2%
    const r = revPoint(mk([...up, 101.9]), [], past)
    expect(r.big).toHaveLength(1)
    expect(r.big[0]).toMatchObject({ idx: 8, price: 104, isTop: true })
    expect(r.big[0]!.text.startsWith("◆大顶")).toBe(true)
  })
  it("confirmedOnly ignores the forming bar", () => {
    const c = mk([100, 100.3, 100.6, 101, 100.7, 100.2])
    const forming = { nowMs: c.at(-1)!.t + 1000 }
    expect(revPoint(c, [], forming).fine).toHaveLength(0)
    expect(revPoint(c, [], { ...forming, confirmedOnly: false }).fine).toHaveLength(1)
  })
})

describe("RevPoint ★ stars", () => {
  it("counts volRatio, 12h extreme, OI 1h change (top: ≥+0.3%)", () => {
    const n = 40
    const closes = Array.from({ length: n }, (_, i) => (i < 35 ? 100 + i * 0.001 : [100.1, 100.5, 100.4, 100.1, 99.7][i - 35]!))
    const c = mk(closes, i => (i === 36 ? 1000 : 100))
    const oi = c.map((b, i) => ({ t: b.t + M5, oi: i >= 36 ? 1010 : 1000 }))  // +1% within the hour
    const r = revPoint(c, oi, past)
    const top = r.fine.find(f => f.isTop && f.idx === 36)!
    expect(top).toBeDefined()
    // vol 1000/sma20 ≥ 2 ✓, OI +1% ✓; 12h high (144 bars) and 24h prior high (288+7) still warming up (na) ✗
    expect(top.stars).toBe(2)
    expect(top.tip).toContain("OI+1%")
    expect(top.tip).toContain("x")
    expect(top.size).toBe(9 + 2 * 5)
    const noOi = revPoint(c, [], past).fine.find(f => f.idx === 36)!
    expect(noOi.stars).toBe(1)
    // with 300 warm-up bars the 12h-extreme and prior-high-touch stars light up too
    const long = mk([...Array(300).fill(100), 101, 100.2], i => (i === 300 ? 1000 : 100))
    const t2 = revPoint(long, [], past).fine.find(f => f.idx === 300)!
    expect(t2.stars).toBe(3)
    expect(t2.tip).toContain("12h极值")
  })
  it("minStars filters labels", () => {
    const c = mk([100, 100.3, 100.6, 101, 100.7, 100.4, 100.2])
    expect(revPoint(c, [], { ...past, minStars: 4 }).fine).toHaveLength(0)
  })
})

describe("RevPoint swing lines", () => {
  it("one point → dotted horizontal; two points → solid ray", () => {
    const na = { barIdx: NaN, price: NaN }
    expect(swingConnect(na, { barIdx: 5, price: 10 }, 9, "#f00", 2)).toMatchObject({ x1: 5, y1: 10, x2: 9, y2: 10, style: "dotted", width: 1, extend: true })
    expect(swingConnect({ barIdx: 2, price: 12 }, { barIdx: 5, price: 10 }, 9, "#f00", 2)).toMatchObject({ style: "solid", extend: true, width: 2 })
  })
  it("freezeLine ends the line at the current bar, dashed, not extended", () => {
    const l = swingConnect({ barIdx: 0, price: 10 }, { barIdx: 10, price: 20 }, 10, "#0f0", 2)!
    expect(freezeLine(l, 15)).toMatchObject({ x2: 15, y2: 25, extend: false, style: "dashed", width: 1 })
  })
  it("trend flip freezes the opposite fine line", () => {
    // bottom → up line, then top → down line freezes fineUp
    const r = revPoint(mk([100, 99.6, 99.2, 98.8, 99.2, 99.6, 100, 100.4, 100, 99.6]), [], past)
    expect(r.fine.map(f => f.isTop)).toEqual([true, false, true])
    expect(r.lines.fineUp!.style).toBe("dashed")
    expect(r.lines.fineUp!.extend).toBe(false)
    expect(r.lines.fineDn!.extend).toBe(true)
  })
})

describe("RevPoint HTF without lookahead", () => {
  it("drops the unclosed HTF bucket", () => {
    const c = mk(Array.from({ length: 30 }, (_, i) => 100 + i))   // 2.5h of 5m bars
    const h = resampleClosed(c, 3600, c.at(-1)!.t + M5)
    expect(h).toHaveLength(2)
  })
  it("chart bars only see an HTF value after that HTF bar closed", () => {
    const c = mk(Array.from({ length: 36 }, (_, i) => 100 + i))
    const e = ema1hSeries(c, 300)
    expect(e.slice(0, 11).every(Number.isNaN)).toBe(true)
    expect(e[11]).toBe(111)            // 1st hour bucket closes with bar 11
    expect(e[12]).toBe(111)            // bar 12 is inside hour 2: no peek
    expect(e[23]).not.toBe(111)
  })
  it("a pivot is visible only after its right leg of HTF bars closed; future bars don't change the past", () => {
    const hourly = [1, 2, 3, 10, 3, 2, 1, 1, 1]
    const c: RpCandle[] = []
    hourly.forEach((v, h) => { for (let k = 0; k < 12; k++) c.push({ t: T0 + (h * 12 + k) * M5, open: v, high: v, low: v, close: v, volume: 1 }) })
    const p = htfPackSeries(c, 300, 3600, 3)
    const firstSeen = p.findIndex(x => x.h1 === 10)
    expect(firstSeen).toBe(6 * 12 + 11)  // hour 6 closes (pivot hour 3 + leg 3)
    const shorter = htfPackSeries(c.slice(0, firstSeen + 1), 300, 3600, 3)
    expect(shorter.map(x => x.h1)).toEqual(p.slice(0, firstSeen + 1).map(x => x.h1))
    expect(p[firstSeen]!.ht1).toBe(T0 + 3 * 3600_000)
  })
  it("report exposes candidate, stars, need and HTF R/S; render is citable", () => {
    const c = mk(Array.from({ length: 200 }, (_, i) => 100 + 3 * Math.sin(i / 12)))
    const rep = revPointReport(c.map(b => ({ ...b, time: new Date(b.t).toISOString() })), [], past)
    expect(rep.candidate).not.toBeNull()
    expect(rep.htf.map(h => h.tf)).toEqual(["1H", "4H"])
    expect(renderRevPoint(rep)).toContain("RevPoint")
  })
  it("supports showHtfPlots, showHtfDebug, and per-bar barEvents", () => {
    const c = mk([100, 100.3, 100.6, 101, 100.7, 100.4, 100.2])
    const r = revPoint(c, [], { ...past, showHtf: true, showHtfPlots: true, showHtfDebug: true })
    expect(r.htfDebugText).toContain("HTF诊断 pivLen=3")
    expect(r.barEvents.fineConfirmed).toHaveLength(c.length)
    expect(r.barEvents.fineConfirmed.some(Boolean)).toBe(true)
    expect(r.htfStepPlots["1H"].r).toHaveLength(c.length)
  })
  it("normalizes tiny negative oiChg1hPct to +0 (never -0) for lossless JSON", () => {
    const c = mk(Array.from({ length: 20 }, () => 100))
    const oi = c.map((b, i) => ({ t: b.t, oi: i === c.length - 1 ? 99_999 : 100_000 }))
    const rep = revPointReport(c.map(b => ({ ...b, time: new Date(b.t).toISOString() })), oi, past)
    expect(rep.oiChg1hPct).toBe(0)
    expect(Object.is(rep.oiChg1hPct, -0)).toBe(false)
  })
})
