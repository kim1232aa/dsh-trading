import { describe, expect, it, vi } from 'vitest'
import { entrySignals, signalStatus } from '../../tool-market/src/signal.js'
import { entrySignalIndicator, signalRows } from '../src/client/indicators/entry-signal.js'
import { formatPrice } from '../src/client/precision.js'
import { mockChart } from '../src/client/indicators/draw-context.js'

const CLOSED = { lastBarClosed: true }
const make = (i: number, close: number, spread = 1) => ({
  timestamp: Date.UTC(2024, 0, 1) + i * 300000,
  open: close - 0.2, high: close + spread, low: close - spread, close, volume: 100,
})
const list = [
  ...Array.from({ length: 120 }, (_, i) => make(i, 200 - i * 0.5 + 2 * Math.sin(i / 2))),
  ...Array.from({ length: 80 }, (_, i) => make(i + 120, 140 + i * 0.8 + 3 * Math.sin(i / 1.5), 1.5)),
]
const bars = list.map(k => ({ ...k, time: String(k.timestamp) }))
const first = entrySignals(bars, 10, 3, CLOSED)[0]!
const tooltip = (rows: ReturnType<typeof signalRows>, index: number) => entrySignalIndicator.createTooltipDataSource({
  indicator: { result: rows, calcParams: [10, 3] }, crosshair: { dataIndex: index },
})

describe('entry signal indicator confirmation and historical display', () => {
  it('has no arrow signal on the live tail and explains waiting for close', () => {
    const prefix = list.slice(0, first.index + 1)
    const rows = entrySignalIndicator.calc(prefix, { calcParams: [10, 3] })
    expect(rows.at(-1)!.signal).toBeUndefined()
    expect(rows.at(-1)!.confirmed).toBe(false)
    expect(tooltip(rows, rows.length - 1).legends.map(v => v.value.text)).toContain('等待收盘，不确认新信号')
  })

  it('confirms the prior tail when the next candle appears', () => {
    const prefix = [...list.slice(0, first.index + 1), make(first.index + 1, first.entry)]
    const rows = signalRows(prefix, 10, 3)
    expect(rows[first.index]!.signal!.index).toBe(first.index)
    expect(rows[first.index]!.confirmed).toBe(true)
    expect(rows.at(-1)!.signal).toBeUndefined()
  })

  it('shows the entry-time state instead of the outcome known at the end of the series', () => {
    const rows = signalRows(list, 10, 3, CLOSED)
    expect(rows[first.index]!.status).not.toBe('open')
    expect(rows[first.index]!.asOfStatus).toBe('open')
    const values = tooltip(rows, first.index).legends
    expect(values.find(v => v.title === '当时: ')!.value.text).toBe('信号跟踪中')
    expect(values.map(v => v.value.text).join(' ')).not.toMatch(/触及止损|触及T2/)
  })

  it('does not show a future signal before its entry candle', () => {
    const rows = signalRows(list, 10, 3, CLOSED)
    expect(rows[first.index - 1]!.tracked).toBeUndefined()
    expect(tooltip(rows, first.index - 1).legends).toEqual([])
  })

  it('keeps every historical tooltip state consistent with the shared evaluator', () => {
    const rows = signalRows(list, 10, 3, CLOSED)
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!
      if (row.tracked !== undefined) {
        expect(row.asOfStatus).toBe(signalStatus(bars, row.tracked, { ...CLOSED, asOfIndex: index }))
      }
    }
  })

  it('keeps prior states and signals stable while a live candle changes', () => {
    const before = signalRows(list, 10, 3)
    const changed = [...list.slice(0, -1), { ...list.at(-1)!, high: 10000, low: 1, close: 10000 }]
    const after = signalRows(changed, 10, 3)
    expect(after.map(r => [r.signal, r.status, r.tracked, r.asOfStatus])).toEqual(before.map(r => [r.signal, r.status, r.tracked, r.asOfStatus]))
  })

  it('does not backfill the default-period warmup signal after later candles arrive', () => {
    let seed = 1
    const warm = Array.from({ length: 70 }, (_, i) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const close = 150 - i * 0.22 + 4 * Math.sin(i / 3 + 3 / 7) + 2 * (seed / 4294967296 - 0.5)
      return make(i, close, i === 59 ? 20 : 1)
    })
    expect(signalRows(warm.slice(0, 60), 60, 4)[59]!.signal).toBeUndefined()
    for (const length of [61, 62, 63, 70]) {
      expect(signalRows(warm.slice(0, length), 60, 4)[59]!.signal!.index).toBe(59)
    }
  })

  it.each([0.0003, 3e-8, 1e-12, 1e-100])('keeps all reference levels nonzero and distinct at price scale %s', scale => {
    const tiny = list.map(k => ({ ...k, open: k.open * scale, high: k.high * scale, low: k.low * scale, close: k.close * scale }))
    const rows = signalRows(tiny, 10, 3, CLOSED)
    const index = rows.findIndex(r => r.signal !== undefined)
    const values = tooltip(rows, index).legends
    const prices = ['参考: ', '损: ', 'T1: ', 'T2: '].map(title => Number(values.find(v => v.title === title)!.value.text))
    expect(prices.every(value => value > 0 && Number.isFinite(value))).toBe(true)
    expect(new Set(prices).size).toBe(4)
    expect(Math.abs(prices[0]! / tiny[index]!.close - 1)).toBeLessThan(0.001)
  })

  it.each([0.0003, 1e-12, 1e-100])('draws nonzero confirmed marker prices at scale %s', scale => {
    const tiny = list.map(k => ({ ...k, open: k.open * scale, high: k.high * scale, low: k.low * scale, close: k.close * scale }))
    const rows = signalRows(tiny, 10, 3, CLOSED)
    const texts: string[] = []
    const ctx = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(),
      fill: vi.fn(), fillRect: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(),
      measureText: (text: string) => ({ width: text.length * 6 }),
      fillText: (text: string) => texts.push(text),
    } as unknown as CanvasRenderingContext2D
    entrySignalIndicator.draw({ ctx, chart: mockChart({ visibleRange: { from: 0, to: rows.length }, kLineDataList: tiny }), indicator: { result: rows },
      xAxis: { convertToPixel: v => v * 3 }, yAxis: { convertToPixel: v => v * 1000 },
      bounding: { width: 1000 } })
    const index = rows.findIndex(r => r.signal !== undefined)
    const signal = rows[index]!.signal!
    const precision = rows[index]!.precision!
    const price = precision > 20 ? String(signal.entry) : formatPrice(signal.entry, precision)
    expect(texts).toContain(`${signal.side === 'long' ? '多' : '空'}·确认 ${price}`)
    expect(Number(price)).toBeGreaterThan(0)
    expect(Math.abs(Number(price) / signal.entry - 1)).toBeLessThan(0.001)
    if (scale === 0.0003) expect(texts.join(' ')).not.toMatch(/\d+\.\d{9,}/)
  })
})

  it('draws latest signal levels even when closed and off-screen', () => {
    // Daily BTC with ST(60,4): last signal is often far left and already target2/stopped.
    // Visible window has no triangles; we still must paint entry/stop/T1/T2 to the right edge.
    const rows = signalRows(list, 10, 3, CLOSED)
    const lastIdx = [...rows].map((r, i) => r.signal ? i : -1).filter(i => i >= 0).at(-1)
    expect(lastIdx).toBeTypeOf('number')
    const last = rows[lastIdx!]!
    // Force a closed status so the old open/target1 gate would hide lines.
    last.status = 'target2'
    const strokes: number[] = []
    const texts: string[] = []
    const ctx = {
      save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(),
      fill: vi.fn(), fillRect: vi.fn(), stroke: () => { strokes.push(1) }, setLineDash: vi.fn(),
      measureText: (text: string) => ({ width: text.length * 6 }),
      fillText: (text: string) => texts.push(text),
    } as unknown as CanvasRenderingContext2D
    const from = Math.min(rows.length - 1, lastIdx! + 5)
    entrySignalIndicator.draw({
      ctx,
      chart: mockChart({ visibleRange: { from, to: rows.length }, kLineDataList: list }),
      indicator: { result: rows },
      xAxis: { convertToPixel: v => v * 3 },
      yAxis: { convertToPixel: v => v },
      bounding: { width: 1000 },
    })
    expect(strokes.length).toBeGreaterThanOrEqual(4)
    expect(texts.some(t => /参考|止损|T1|T2/.test(t))).toBe(true)
  })

