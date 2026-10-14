import { describe, expect, it } from 'vitest'
import { confirmedBarCount, entrySignals, reachedT1, renderSignal, signalReport, signalStatus } from '../src/signal.js'
import type { EntrySignal, SignalBar } from '../src/signal.js'

const CLOSED = { lastBarClosed: true }
const bar = (i: number, close: number, spread = 1): SignalBar => ({
  time: new Date(Date.UTC(2024, 0, 1) + i * 300000).toISOString(),
  open: close - 0.2, high: close + spread, low: close - spread, close, volume: 100,
})
const series = [
  ...Array.from({ length: 120 }, (_, i) => bar(i, 200 - i * 0.5 + 2 * Math.sin(i / 2))),
  ...Array.from({ length: 80 }, (_, i) => bar(i + 120, 140 + i * 0.8 + 3 * Math.sin(i / 1.5), 1.5)),
]
const first = entrySignals(series, 10, 3, CLOSED)[0]!
const long: EntrySignal = { index: 0, time: '', side: 'long', kind: 'flip', entry: 100, stop: 95, target1: 107.5, target2: 115 }

function overlapFixture(): SignalBar[] {
  let seed = 1, previous = 150
  return Array.from({ length: 400 }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const close = 150 + (i < 120 ? -0.25 * i : -30 + 0.35 * (i - 120))
      + 4 * Math.sin(i / 3) + 2 * (seed / 4294967296 - 0.5)
    const result = { ...bar(i, close), open: previous, high: Math.max(previous, close) + 0.5, low: Math.min(previous, close) - 0.5 }
    previous = close
    return result
  })
}

function pendingT1(): SignalBar[] {
  const risk = Math.abs(first.entry - first.stop)
  const high = first.side === 'long' ? first.target1 + risk * 0.01 : first.entry
  const low = first.side === 'short' ? first.target1 - risk * 0.01 : first.entry
  return [...series.slice(0, first.index + 1), ...Array.from({ length: 12 }, (_, i) => ({
    ...bar(first.index + 1 + i, first.target1), open: first.entry, high, low,
  }))]
}

describe('closed-bar signal lifecycle', () => {
  it('requires explicit confirmation of a tail and bounds historical observations', () => {
    expect(confirmedBarCount(3)).toBe(2)
    expect(confirmedBarCount(3, CLOSED)).toBe(3)
    expect(confirmedBarCount(3, { ...CLOSED, asOfIndex: 0 })).toBe(1)
    expect(confirmedBarCount(3, { ...CLOSED, asOfIndex: 100 })).toBe(3)
    expect(confirmedBarCount(0)).toBe(0)
    expect(confirmedBarCount(3, { asOfIndex: -1 })).toBe(0)
  })

  it('never emits a confirmed signal on a potentially live tail', () => {
    const prefix = series.slice(0, first.index + 1)
    expect(entrySignals(prefix, 10, 3).some(s => s.index === first.index)).toBe(false)
    expect(entrySignals(prefix, 10, 3, CLOSED).some(s => s.index === first.index)).toBe(true)
    expect(entrySignals([...prefix, bar(first.index + 1, first.entry)], 10, 3).some(s => s.index === first.index)).toBe(true)
  })

  it('keeps confirmed signals and reports stable when only the live tail changes', () => {
    const prefix = series.slice(0, first.index + 1)
    const changed = [...prefix.slice(0, -1), { ...prefix.at(-1)!, high: 501, low: 1, close: 500 }]
    expect(entrySignals(changed, 10, 3)).toEqual(entrySignals(prefix, 10, 3))
    expect(signalReport(changed, 10, 3)).toEqual(signalReport(prefix, 10, 3))
  })

  it('does not change historical signals when future bars are appended', () => {
    const all = entrySignals(series, 10, 3, CLOSED)
    for (let index = 60; index < series.length; index += 11) {
      expect(entrySignals(series.slice(0, index + 1), 10, 3, CLOSED)).toEqual(all.filter(s => s.index <= index))
      expect(entrySignals(series, 10, 3, { ...CLOSED, asOfIndex: index })).toEqual(all.filter(s => s.index <= index))
    }
  })

  it.each([0.0003, 3e-8, 1e-12])('preserves positive risk and distinct levels for price scale %s', scale => {
    const scaled = series.map(b => ({ ...b, open: b.open * scale, high: b.high * scale, low: b.low * scale, close: b.close * scale }))
    const signals = entrySignals(scaled, 10, 3, CLOSED)
    expect(signals.length).toBeGreaterThan(0)
    for (const s of signals) {
      const sign = s.side === 'long' ? 1 : -1
      const risk = sign * (s.entry - s.stop)
      expect(s.entry).toBe(scaled[s.index]!.close)
      expect(risk).toBeGreaterThan(0)
      expect(sign * (s.target1 - s.entry)).toBeGreaterThan(0)
      expect(sign * (s.target2 - s.target1)).toBeGreaterThan(0)
      expect(Math.abs(s.target1 - (s.entry + sign * 1.5 * risk))).toBeLessThan(risk * 1e-9)
    }
  })

  it('suppresses the previously reproduced overlapping signal at bar 83', () => {
    const bars = overlapFixture()
    const signals = entrySignals(bars, 10, 1, CLOSED)
    expect(signals[0]!.index).toBe(65)
    expect(signals.some(s => s.index === 83)).toBe(false)
    expect(signals.length).toBeGreaterThan(2)
    for (let i = 1; i < signals.length; i++) {
      const prior = signalStatus(bars, signals[i - 1]!, { ...CLOSED, asOfIndex: signals[i]!.index })
      expect(['stopped', 'target2']).toContain(prior)
    }
  })

  it('keeps T1 tracking active and excludes it from finished counts', () => {
    const bars = pendingT1()
    const report = signalReport(bars, 10, 3, 48, CLOSED)
    expect(report.latest!.status).toBe('target1')
    expect(report.record).toEqual({ finished: 0, hitT1: 0, hitT2: 0, stopped: 0, active: 1 })
    expect(entrySignals(bars, 10, 3, CLOSED)).toHaveLength(1)
    expect(report.blockers).toContain('已有信号跟踪中，等待止损或T2结束')
  })

  it('counts an eventual stop after T1 as ended while retaining the earlier T1 touch', () => {
    const bars = pendingT1()
    const risk = Math.abs(first.entry - first.stop)
    bars.push({ ...bar(bars.length, first.stop), open: first.target1,
      high: Math.max(first.stop, first.target1) + risk * 0.01,
      low: Math.min(first.stop, first.target1) - risk * 0.01 })
    expect(signalStatus(bars, first, CLOSED)).toBe('stopped')
    expect(reachedT1(bars, first, CLOSED)).toBe(true)
    const report = signalReport(bars, 10, 3, 48, CLOSED)
    expect(report.record.finished).toBe(1)
    expect(report.record.hitT1).toBe(1)
    expect(report.record.hitT2).toBe(0)
    expect(report.record.stopped).toBe(1)
  })

  it('ignores unconfirmed exits and honors historical status boundaries', () => {
    const bars = [bar(0, 100), { ...bar(1, 108), high: 108 }, { ...bar(2, 115), high: 116 }]
    expect(signalStatus(bars, long)).toBe('target1')
    expect(signalStatus(bars, long, CLOSED)).toBe('target2')
    expect(signalStatus(bars, long, { ...CLOSED, asOfIndex: 0 })).toBe('open')
    expect(signalStatus(bars, long, { ...CLOSED, asOfIndex: 1 })).toBe('target1')
  })

  it('uses conservative stop-first ordering for both sides and keeps terminal outcomes immutable', () => {
    const short = { ...long, side: 'short' as const, stop: 105, target1: 92.5, target2: 85 }
    const ambiguous = [bar(0, 100), { ...bar(1, 100), high: 106, low: 84 }]
    expect(signalStatus(ambiguous, short, CLOSED)).toBe('stopped')
    expect(reachedT1(ambiguous, short, CLOSED)).toBe(false)
    const done = [bar(0, 100), { ...bar(1, 90), low: 84, high: 100 }, { ...bar(2, 110), high: 111 }]
    expect(signalStatus(done, short, CLOSED)).toBe('target2')
    expect(reachedT1(done, short, CLOSED)).toBe(true)
  })

  it('reports touches rather than an unmodeled return or win rate', () => {
    const text = renderSignal(signalReport(pendingT1(), 10, 3, 48, CLOSED))
    expect(text).toContain('跟踪中 1 条')
    expect(text).toContain('非成交/收益回测')
    expect(text).toContain('未计手续费/滑点')
    expect(text).not.toMatch(/期望|盈亏平衡|胜率/)
  })

  it.each([[0, false, 0.1, 60], [3, true, 4, 59]] as const)(
    'confirms warmup at its own bar (phase=%s wide=%s factor=%s index=%s)', (phase, wide, factor, index) => {
      let seed = 1
      const bars = Array.from({ length: 70 }, (_, i) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        const close = 150 - i * 0.22 + 4 * Math.sin(i / 3 + phase / 7) + 2 * (seed / 4294967296 - 0.5)
        return bar(i, close, wide && i === 59 ? 20 : 1)
      })
      const full = entrySignals(bars, 60, factor, CLOSED).filter(s => s.index <= index)
      expect(full.some(s => s.index === index)).toBe(true)
      expect(entrySignals(bars.slice(0, index + 1), 60, factor, CLOSED)).toEqual(full)
      expect(entrySignals(bars, 60, factor, { ...CLOSED, asOfIndex: index })).toEqual(full)
    },
  )

  it('handles empty and warmup-only input without emitting signals', () => {
    expect(signalReport([]).record).toEqual({ finished: 0, hitT1: 0, hitT2: 0, stopped: 0, active: 0 })
    expect(entrySignals(series.slice(0, 20))).toEqual([])
  })
})
