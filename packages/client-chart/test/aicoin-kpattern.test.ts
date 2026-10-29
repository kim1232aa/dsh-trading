import { describe, expect, it } from 'vitest'
import {
  KP_ALERT, KP_ALERTS, KP_BAIDU_CATALOG, KP_BAIDU_PLOTS, KP_BAIDU_SHOW, KP_BG_ON, KP_COLOR, KP_DEFAULTS, KP_FONT,
  KP_FORMING, KP_LAST, KP_MODE, KP_PLOTS, KP_SHOW, KP_THEME,
  calculateKPatterns, createKPatternTooltipDataSource, drawKPatterns, kPatternIndicator, kpAlertEvents, kpAllHits,
  kpBaiduHits, kpHits, sanitizeKPatternParams,
  type KpCandle,
} from '../src/client/indicators/aicoin-kpattern.js'
import { EDITABLE, sanitizeSettings } from '../src/client/ChartCard.js'
import { mockChart } from '../src/client/indicators/draw-context.js'

/** Neutral bar: o=100 h=101 l=99 c=100 (no body, so no single-bar pattern can fire on it). */
const base = (n: number): KpCandle[] => Array.from({ length: n }, () => ({ open: 100, high: 101, low: 99, close: 100 }))
const bar = (open: number, high: number, low: number, close: number): KpCandle => ({ open, high, low, close })
const hitsAtLast = (c: KpCandle[]) => kpHits(calculateKPatterns(c)[c.length - 1])
const baiduHitsAtLast = (c: KpCandle[]) => kpBaiduHits(calculateKPatterns(c)[c.length - 1])

describe('AiCoin K线形态 — each plotText condition, hand-computed', () => {
  it('neutral history fires nothing', () => {
    expect(calculateKPatterns(base(30)).every(r => kpAllHits(r).length === 0)).toBe(true)
  })
  it('锤子线: under 2.0>=2*0.4, ampl 2.5/100>0.005, low 98<lowest(low[1],10)=99, over 0.1<0.2', () => {
    expect(hitsAtLast([...base(11), bar(100, 100.5, 98, 100.4)])).toEqual(['hammer'])
  })
  it('锤子线 needs 10 prior lows: lowest(low[1],10) is nan on bar 9, so nothing fires', () => {
    expect(hitsAtLast([...base(9), bar(100, 100.5, 98, 100.4)])).toEqual([])
  })
  it('锤子线 with a zero body cannot fire (overshadow < 0.5*solid = 0)', () => {
    expect(hitsAtLast([...base(11), bar(100, 100, 98, 100)])).toEqual([])
  })
  it('上吊线: hammer shape, high[1]=103 > highest(high[2],10)=101; low 100 not below lowest(low[1],10)', () => {
    expect(hitsAtLast([...base(11), bar(100, 103, 99.5, 101), bar(102, 102.5, 100, 102.4)])).toEqual(['hangingMan'])
  })
  it('流星线: over 2.0>=0.8, high 102 > highest(high[1],10)=101, under 0.1<0.2', () => {
    expect(hitsAtLast([...base(11), bar(100, 102, 99.5, 99.6)])).toEqual(['shootingStar'])
  })
  it('乌云盖顶: bull 100→102 then bear 102.5→100.8 (<101 mid), high[1]=102.2>highest(high[2],5)=101', () => {
    expect(hitsAtLast([...base(11), bar(100, 102.2, 99.8, 102), bar(102.5, 102.6, 100.7, 100.8)])).toEqual(['darkCloudCover'])
  })
  it('刺透: bear 100→98 then bull 97.5→99.2 (>99 mid), low[1]=97.8<lowest(low[2],5)=99', () => {
    expect(hitsAtLast([...base(11), bar(100, 100.2, 97.8, 98), bar(97.5, 99.3, 97.4, 99.2)])).toEqual(['piercingLine'])
  })
  it('平头顶: high == high[1] (102) and high[1] > highest(high[2],5)=101', () => {
    expect(hitsAtLast([...base(11), bar(100, 102, 99.9, 101.5), bar(101.5, 102, 100.9, 101)])).toEqual(['dojiTop'])
  })
  it('平头顶 tolerance is |dh|/high[1] <= 0.000015', () => {
    // 102 * 0.000015 = 0.00153: 0.0015 passes, 0.0016 does not
    expect(hitsAtLast([...base(11), bar(100, 102, 99.9, 101.5), bar(101.5, 102.0015, 100.9, 101)])).toEqual(['dojiTop'])
    expect(hitsAtLast([...base(11), bar(100, 102, 99.9, 101.5), bar(101.5, 102.0016, 100.9, 101)])).toEqual([])
  })
  it('平头底: low == low[1] (98) and low[1] < lowest(low[2],5)=99', () => {
    expect(hitsAtLast([...base(11), bar(100, 100.1, 98, 98.5), bar(98.5, 99.1, 98, 99)])).toEqual(['dojiBottom'])
  })
  it('平头顶/平头底 rejects Marubozu close-at-extreme followed by open-at-extreme (single turn at bar boundary)', () => {
    expect(hitsAtLast([...base(11), bar(100, 102, 99.9, 102), bar(102, 102, 100.5, 101)])).toEqual([])
    expect(hitsAtLast([...base(11), bar(100, 100.1, 98, 98), bar(98, 99.5, 98, 99)])).toEqual([])
  })
  it('看涨吞没: 100→99.5 then 99.3→100.5, wave 1.2/99.3>0.005, low 99.2<99.4', () => {
    expect(hitsAtLast([...base(11), bar(100, 100.1, 99.4, 99.5), bar(99.3, 100.6, 99.2, 100.5)])).toEqual(['bullishEngulfing'])
  })
  it('看涨吞没 requires low < low[1]', () => {
    expect(hitsAtLast([...base(11), bar(100, 100.1, 99.4, 99.5), bar(99.3, 100.6, 99.45, 100.5)])).toEqual([])
  })
  it('看跌吞没: 100→100.5 then 100.7→99.5, wave 1.2/100.7>0.005, high 100.8>100.6', () => {
    expect(hitsAtLast([...base(11), bar(100, 100.6, 99.9, 100.5), bar(100.7, 100.8, 99.4, 99.5)])).toEqual(['bearishEngulfing'])
  })
  it('启明星 (+底分型 on the same bar): |0.1| < 0.24*min(2,3), close 99>97, high[1] 96.7<99, low[1] 96<96.9', () => {
    const c = [...base(10), bar(100, 100.1, 96.9, 97), bar(96.5, 96.7, 96, 96.6), bar(97, 99.1, 96.9, 99)]
    expect(hitsAtLast(c)).toEqual(['morningStar', 'bottomFormation'])
  })
  it('启明星 rejects a star body >= 0.24 * the smaller outer body', () => {
    // |0.5| < 0.24*min(2,3)=0.48 is false
    const c = [...base(10), bar(100, 100.1, 96.9, 97), bar(96.1, 96.7, 96, 96.6), bar(97, 99.1, 96.9, 99)]
    expect(hitsAtLast(c)).not.toContain('morningStar')
  })
  it('黄昏星 (+顶分型 on the same bar): |0.1| < 0.48, close 101<103, high[1] 104>103.1, low[1] 103.3>101', () => {
    const c = [...base(10), bar(100, 103.1, 99.9, 103), bar(103.5, 104, 103.3, 103.4), bar(103, 103.1, 100.9, 101)]
    expect(hitsAtLast(c)).toEqual(['eveningStar', 'topFormation'])
  })
  it('红三兵: three bull bars, rising closes, each wave 0.5/~100 > 0.003', () => {
    const c = [...base(10), bar(100, 100.6, 99.95, 100.5), bar(100.5, 101.1, 100.45, 101), bar(101, 101.6, 100.95, 101.5)]
    expect(hitsAtLast(c)).toEqual(['redThreeSoldiers'])
  })
  it('红三兵 fails when one wave <= 0.003', () => {
    const c = [...base(10), bar(100, 100.6, 99.95, 100.25), bar(100.5, 101.1, 100.45, 101), bar(101, 101.6, 100.95, 101.5)]
    expect(hitsAtLast(c)).toEqual([])
  })
  it('黑三兵: three bear bars, falling closes, each wave > 0.003', () => {
    const c = [...base(10), bar(100, 100.05, 99.4, 99.5), bar(99.5, 99.55, 98.9, 99), bar(99, 99.05, 98.4, 98.5)]
    expect(hitsAtLast(c)).toEqual(['blackThreeSoldiers'])
  })
  it('顶分型: high[1]=102 above both neighbours and highest(high[2],10)=101; close 100.9<101.5', () => {
    expect(hitsAtLast([...base(11), bar(100.5, 102, 99.5, 101.5), bar(101, 101.5, 99.4, 100.9)])).toEqual(['topFormation'])
  })
  it('底分型: low[1]=98.5 below neighbours and lowest(low[2],10)=99; close 100.8 > high[1] 100.5', () => {
    expect(hitsAtLast([...base(11), bar(100, 100.5, 98.5, 99.5), bar(99.8, 100.9, 99, 100.8)])).toEqual(['bottomFormation'])
  })
})

describe('Baidu Finance / TradingCentral 24 形态目录与 19 扩展形态计算', () => {
  it('KP_BAIDU_CATALOG has 24 items sorted by type id (70..123), reusing 5 AiCoin keys and 19 Baidu keys', () => {
    expect(KP_BAIDU_CATALOG).toHaveLength(24)
    expect(KP_BAIDU_CATALOG.map(item => item.type)).toEqual([
      70, 71, 101, 102, 103, 104, 106, 107, 108, 109, 110, 111,
      112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123,
    ])
    expect(KP_BAIDU_CATALOG.map(item => [item.type, item.title, item.key, item.direction])).toEqual([
      [70, '圆弧顶', 'roundingTop', 'bear'],
      [71, '圆弧底', 'roundingBottom', 'bull'],
      [101, '跳空上涨', 'gapUp', 'bull'],
      [102, '跳空下跌', 'gapDown', 'bear'],
      [103, '岛形顶部', 'islandTop', 'bear'],
      [104, '岛形底部', 'islandBottom', 'bull'],
      [106, '射击之星', 'shootingStar', 'bear'],
      [107, '吊人形态', 'hangingMan', 'bear'],
      [108, '吞没线（看涨）', 'bullishEngulfing', 'bull'],
      [109, '吞没线（看跌）', 'bearishEngulfing', 'bear'],
      [110, '墓碑线（看涨）', 'gravestoneBull', 'bull'],
      [111, '锤形线', 'hammer', 'bull'],
      [112, '倒锤线', 'invertedHammer', 'bull'],
      [113, '覆盖线（看涨）', 'outsideBull', 'bull'],
      [114, '覆盖线（看跌）', 'outsideBear', 'bear'],
      [115, '被覆盖线（看涨）', 'haramiBull', 'bull'],
      [116, '被覆盖线（看跌）', 'haramiBear', 'bear'],
      [117, '关键反转线（看跌）', 'keyRevBear', 'bear'],
      [118, '关键反转线（看涨）', 'keyRevBull', 'bull'],
      [119, '衰竭线（看跌）', 'exhaustionBear', 'bear'],
      [120, '衰竭线（看涨）', 'exhaustionBull', 'bull'],
      [121, '两线反转（看涨）', 'twoBarRevBull', 'bull'],
      [122, '两线反转（看跌）', 'twoBarRevBear', 'bear'],
      [123, '墓碑线（看跌）', 'gravestoneBear', 'bear'],
    ])
    expect(KP_BAIDU_CATALOG.every(item => item.meaning.length > 0 && item.description.length > 0)).toBe(true)
    expect(KP_BAIDU_PLOTS).toHaveLength(19)
  })

  it('70 圆弧顶 & 71 圆弧底 over 10-bar window', () => {
    const topArch = [
      bar(99, 100, 98, 99.5), bar(99.5, 101, 99, 100.5), bar(100.5, 102, 100, 101.5),
      bar(101.5, 104, 101, 103.5), bar(103.5, 105, 103, 104.5), bar(104.5, 105, 103, 104), bar(104, 104, 102.5, 103),
      bar(103, 103, 101.5, 102), bar(102, 102, 100.5, 101), bar(101, 101, 98.5, 99),
    ]
    expect(baiduHitsAtLast(topArch)).toContain('roundingTop')

    const bottomBowl = [
      bar(101, 102, 100, 100.5), bar(100.5, 101, 99, 99.5), bar(99.5, 100, 98, 98.5),
      bar(98.5, 99, 96, 96.5), bar(96.5, 97, 95, 95.5), bar(95.5, 97, 95, 96), bar(96, 97.5, 96, 97),
      bar(97, 98.5, 97, 98), bar(98, 99.5, 98, 99), bar(99, 101.5, 99, 101),
    ]
    expect(baiduHitsAtLast(bottomBowl)).toContain('roundingBottom')
  })

  it('101 跳空上涨 & 102 跳空下跌 & 103 岛形顶部 & 104 岛形底部', () => {
    expect(baiduHitsAtLast([...base(5), bar(102, 103, 101.5, 102.5)])).toEqual(['gapUp'])
    expect(baiduHitsAtLast([...base(5), bar(98, 98.5, 97, 97.5)])).toEqual(['gapDown'])
    expect(baiduHitsAtLast([...base(5), bar(102, 103, 101.5, 102.5), bar(100, 101, 99.5, 100)])).toEqual(['gapDown', 'islandTop'])
    expect(baiduHitsAtLast([...base(5), bar(98, 98.5, 97, 97.5), bar(100, 100.5, 99, 100)])).toEqual(['gapUp', 'islandBottom'])
  })

  it('110 墓碑线(看涨) & 112 倒锤线 & 123 墓碑线(看跌)', () => {
    expect(baiduHitsAtLast([...base(11), bar(98.1, 100, 98, 98.2)])).toEqual(['gravestoneBull'])
    expect(baiduHitsAtLast([...base(11), bar(98.1, 99.6, 98, 98.5)])).toEqual(['invertedHammer'])
    expect(baiduHitsAtLast([...base(11), bar(100.2, 102, 100, 100.1)])).toEqual(['gravestoneBear'])
  })

  it('113 覆盖线(看涨) & 114 覆盖线(看跌) & 115 被覆盖线(看涨) & 116 被覆盖线(看跌)', () => {
    expect(baiduHitsAtLast([...base(10), bar(100, 100.2, 98.5, 99), bar(98.8, 100.5, 98.2, 100.2)])).toEqual(['outsideBull'])
    expect(baiduHitsAtLast([...base(10), bar(100, 101.5, 99.8, 101), bar(101.2, 101.8, 99.5, 99.8)])).toEqual(['outsideBear'])
    expect(baiduHitsAtLast([...base(10), bar(100, 100.2, 98, 98.2), bar(98.5, 99.5, 98.3, 99.2)])).toEqual(['haramiBull'])
    expect(baiduHitsAtLast([...base(10), bar(100, 102, 99.8, 101.8), bar(101.5, 101.7, 100.5, 100.8)])).toEqual(['haramiBear'])
  })

  it('117 关键反转线(看跌) & 118 关键反转线(看涨)', () => {
    expect(baiduHitsAtLast([...base(11), bar(100, 101.2, 99.8, 101), bar(101.5, 102, 99.5, 99.6)])).toContain('keyRevBear')
    expect(baiduHitsAtLast([...base(11), bar(100, 100.2, 98.8, 99), bar(98.5, 100.5, 98, 100.4)])).toContain('keyRevBull')
  })

  it('119 衰竭线(看跌) & 120 衰竭线(看涨)', () => {
    expect(baiduHitsAtLast([...base(10), bar(100, 101.5, 99.8, 101.2), bar(101.8, 102, 100.8, 101)])).toEqual(['exhaustionBear'])
    expect(baiduHitsAtLast([...base(10), bar(100, 100.2, 98.5, 98.8), bar(98.2, 99.2, 98, 99)])).toEqual(['exhaustionBull'])
  })

  it('121 两线反转(看涨) & 122 两线反转(看跌)', () => {
    expect(baiduHitsAtLast([...base(10), bar(100, 100.1, 98, 98.2), bar(98.3, 100.4, 98.2, 100.2)])).toEqual(['twoBarRevBull'])
    expect(baiduHitsAtLast([...base(10), bar(100, 102, 99.9, 101.8), bar(101.7, 101.8, 99.6, 99.8)])).toEqual(['twoBarRevBear'])
  })
})

describe('AiCoin K线形态 — plotText / alertcondition metadata', () => {
  it('15 plotText entries with source title/text/color/refSeries/placement', () => {
    expect(KP_PLOTS.map(p => [p.title, p.text, p.color, p.ref, p.placement])).toEqual([
      ['锤子线', '锤子线', 'green', 'low', 'bottom'],
      ['上吊线', '上吊线', 'red', 'high', 'top'],
      ['流星线', '流星线', 'red', 'high', 'top'],
      ['乌云盖顶', '乌云盖顶', 'red', 'high', 'top'],
      ['刺透', '刺透', 'green', 'low', 'bottom'],
      ['平头顶', '平头顶', 'red', 'high', 'top'],
      ['平头底', '平头底', 'green', 'low', 'bottom'],
      ['看涨吞没', '涨吞没', 'green', 'low', 'bottom'],
      ['看跌吞没', '跌吞没', 'red', 'high', 'top'],
      ['启明星', '启明星', 'green', 'low', 'bottom'],
      ['黄昏星', '黄昏星', 'red', 'high', 'top'],
      ['红三兵', '红三兵', 'green', 'low', 'bottom'],
      ['黑三兵', '黑三兵', 'red', 'high', 'top'],
      ['顶分型', '顶分型', 'red', 'high', 'top'],
      ['底分型', '底分型', 'green', 'low', 'bottom'],
    ])
  })
  it('15 alertconditions in source order with direction', () => {
    expect(KP_ALERTS.map(a => a.title + ':' + a.direction)).toEqual([
      '锤子线:buy', '上吊线:sell', '流星线:sell', '看涨吞没:buy', '看跌吞没:sell', '乌云盖顶:sell', '刺透形态:buy',
      '启明星:buy', '黄昏星:sell', '平头顶:sell', '平头底:buy', '顶分型:sell', '底分型:buy', '红三兵:buy', '黑三兵:sell',
    ])
  })
  it('defaults: 15 AiCoin shown, green #008000 / red #ff0000, fontSize 12, white bg, alerts off; Baidu 19 slots default off', () => {
    expect(KP_DEFAULTS).toHaveLength(71)
    expect(KP_DEFAULTS.slice(KP_THEME, KP_BAIDU_SHOW)).toEqual([1, 0, 1, 0])
    expect(KP_DEFAULTS.slice(KP_BAIDU_SHOW)).toEqual(Array(19).fill(0))
    expect([KP_THEME, KP_MODE, KP_FORMING, KP_LAST, KP_BAIDU_SHOW]).toEqual([48, 49, 50, 51, 52])
    expect(KP_DEFAULTS.slice(KP_SHOW, KP_SHOW + 15).every(v => v === 1)).toBe(true)
    expect(KP_DEFAULTS[KP_COLOR]).toBe(0x008000)
    expect(KP_DEFAULTS[KP_COLOR + 1]).toBe(0xff0000)
    expect(KP_DEFAULTS.slice(KP_FONT, KP_FONT + 3)).toEqual([12, 1, 0xffffff])
    expect(KP_DEFAULTS.slice(KP_ALERT, KP_THEME).every(v => v === 0)).toBe(true)
    expect(sanitizeKPatternParams(KP_DEFAULTS.slice(0, 52)).baiduShow.every(v => !v)).toBe(true)
    expect(sanitizeKPatternParams(undefined).baiduShow.every(v => !v)).toBe(true)
    expect(sanitizeKPatternParams([]).baiduShow.every(v => !v)).toBe(true)
  })
})

describe('AiCoin K线形态 — alerts on the last closed bar', () => {
  const withTime = (c: KpCandle[]) => c.map((k, i) => ({ ...k, time: '2026-10-23T00:' + String(i).padStart(2, '0') + ':00Z' }))
  // hammer on bar 11 (closed), bar 12 still forming
  const candles = withTime([...base(11), bar(100, 100.5, 98, 100.4), bar(100.4, 100.5, 100.3, 100.4)])
  it('silent while every alert toggle is off', () => {
    expect(kpAlertEvents(candles, KP_DEFAULTS)).toEqual([])
  })
  it('fires the enabled alertcondition for the closed bar only', () => {
    expect(KP_DEFAULTS.slice(KP_ALERT, KP_ALERT + 15)).toHaveLength(15)
    const p = [...KP_DEFAULTS]; p[KP_ALERT + 0] = 1
    expect(kpAlertEvents(candles, p)).toEqual([{ id: candles[11]!.time + '|kp.hammer', text: '锤子线 · 买入 (' + candles[11]!.time + ')' }])
    expect(kpAlertEvents(candles.slice(0, 12), p)).toEqual([])
  })
})

describe('AiCoin K线形态 — drawing', () => {
  function mockCtx() {
    const texts: { text: string; color: string; x: number; y: number; alpha: number }[] = []
    const rects: { color: string; x: number; y: number; w: number; h: number }[] = []
    const strokes: string[] = []
    const stems: { color: string; x0: number; y0: number; x1: number; y1: number }[] = []
    let tris = 0
    let mx = 0, my = 0, lx = 0, ly = 0
    const ctx = {
      font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
      save() {}, restore() {}, beginPath() {},
      moveTo(x: number, y: number) { mx = x; my = y },
      lineTo(x: number, y: number) { lx = x; ly = y },
      closePath() {},
      stroke(this: { strokeStyle: string }) { stems.push({ color: this.strokeStyle, x0: mx, y0: my, x1: lx, y1: ly }) },
      fill() { tris++ },
      measureText: (s: string) => ({ width: s.length * 10 }),
      fillText(this: { fillStyle: string; globalAlpha: number }, text: string, x: number, y: number) { texts.push({ text, color: this.fillStyle, x, y, alpha: this.globalAlpha }) },
      fillRect(this: { fillStyle: string }, x: number, y: number, w: number, h: number) { rects.push({ color: this.fillStyle, x, y, w, h }) },
      strokeRect(this: { strokeStyle: string }) { strokes.push(this.strokeStyle) },
    }
    return { ctx, texts, rects, strokes, stems, tris: () => tris }
  }
  const run = (c: KpCandle[], params: number[], extendData?: unknown, xStep = 10, height?: number) => {
    const m = mockCtx()
    drawKPatterns({
      ctx: m.ctx as never,
      chart: mockChart({ visibleRange: { from: 0, to: c.length }, kLineDataList: c }),
      indicator: { calcParams: params, result: calculateKPatterns(c), extendData },
      xAxis: { convertToPixel: i => i * xStep },
      yAxis: { convertToPixel: v => 1000 - v },
      ...(height !== undefined ? { bounding: { width: 1000, height } } : {}),
    })
    return m
  }
  // evening star + top fractal on bar 12, then a closed neutral bar 13 (so bar 12 is not the forming bar)
  const star = [...base(10), bar(100, 103.1, 99.9, 103), bar(103.5, 104, 103.3, 103.4), bar(103, 103.1, 100.9, 101), bar(100, 101, 99, 100)]
  const src = (theme = 0) => { const p = KP_DEFAULTS.slice(0, KP_BAIDU_SHOW); p[KP_THEME] = theme; return p }

  it('source colours: top placements stack above high in plotText order, red text on white plotText box', () => {
    const { texts, rects } = run(star, src())
    // high 103.1 → y0 896.9; box 12+4=16; gap 8 → slot0 top 872.9 (centre 880.9), slot1 top 854.9 (centre 862.9)
    expect(texts.map(t => t.text)).toEqual(['黄昏星', '顶分型'])
    expect(texts.every(t => t.color === '#ff0000' && t.x === 120 && t.alpha === 1)).toBe(true)
    expect(texts[0]!.y).toBeCloseTo(880.9, 6)
    expect(texts[1]!.y).toBeCloseTo(862.9, 6)
    expect(rects.map(r => r.color)).toEqual(['#ffffff', '#ffffff'])
  })
  it('hidden plotText and disabled background', () => {
    const p = src(); p[KP_SHOW + 10] = 0; p[KP_BG_ON] = 0
    const { texts, rects } = run(star, p)
    expect(texts.map(t => t.text)).toEqual(['顶分型'])
    expect(rects).toEqual([])
  })
  it('theme mode uses the chart down colour as clean text without pill box/border and draws pointer stems', () => {
    const { texts, rects, strokes, stems } = run(star, src(1), { up: '#3ddc97', down: '#f47067', bg: 'rgba(13, 17, 23, 0.85)' })
    expect(texts.map(t => t.color)).toEqual(['#f47067', '#f47067'])
    expect(rects).toEqual([])
    expect(strokes).toEqual([])
    expect(stems).toHaveLength(2)
    expect(stems[0]).toEqual({ color: '#f47067', x0: 120, y0: 894.9, x1: 120, y1: 887.9 })
  })
  it('theme mode without theme data falls back to the source colours', () => {
    expect(run(star, src(1)).texts.map(t => t.color)).toEqual(['#ff0000', '#ff0000'])
  })
  it('TD reserve pushes labels further out', () => {
    const { texts } = run(star, src(), { up: '#0f0', down: '#f00', bg: '#000', reserve: 18 })
    expect(texts[0]!.y).toBeCloseTo(880.9 - 18, 6)
  })
  it('auto mode: crowded labels fall back to short text, then to a triangle', () => {
    // xStep 1: every bar overlaps every label → bar 12 gets 2 full labels? no: only 3 slots, all free on the first bar
    const { texts } = run(star, src(), undefined, 10, 60)
    // pane only 60px tall: label boxes above y=896.9 are off-pane → triangles
    expect(texts).toEqual([])
    const m = run(star, src(), undefined, 10, 60)
    expect(m.tris()).toBe(2)
  })
  it('auto mode: adjacent-bar collision makes the second label use the short form', () => {
    // two hammers on consecutive bars 11 and 12 (lows 98 then 97.5), labels 30px wide but bars 5px apart
    const c = [...base(11), bar(100, 100.5, 98, 100.4), bar(100, 100.5, 97.5, 100.4), bar(100, 101, 99, 100)]
    const { texts } = run(c, src(), undefined, 5)
    expect(texts.map(t => t.text)).toEqual(['锤子线', '锤子线'])
    // second one could not sit at slot 0 (overlap) → moved one slot further down
    expect(texts[1]!.y).toBeGreaterThan(texts[0]!.y)
  })
  it('marks-only mode draws triangles, no text', () => {
    const p = src(); p[KP_MODE] = 3
    const m = run(star, p)
    expect(m.texts).toEqual([])
    expect(m.tris()).toBe(2)
  })
  it('forming (last) bar is translucent, or skipped when switched off', () => {
    const forming = star.slice(0, 13)
    expect(run(forming, src()).texts.every(t => t.alpha === 0.5)).toBe(true)
    const p = src(); p[KP_FORMING] = 0
    expect(run(forming, p).texts).toEqual([])
  })
  it('showLast limits drawing to the most recent N bars', () => {
    const p = src(); p[KP_LAST] = 1
    expect(run(star, p).texts).toEqual([])
    p[KP_LAST] = 2
    expect(run(star, p).texts).toHaveLength(2)
  })
  it('draws active KP_BAIDU_PLOTS and includes them in tooltip when baiduShow is enabled', () => {
    const c = [...base(5), bar(102, 103, 101.5, 102.5), bar(100, 101, 99, 100)]
    const p = [...KP_DEFAULTS]; p[KP_THEME] = 0
    for (let j = 0; j < KP_BAIDU_PLOTS.length; j++) p[KP_BAIDU_SHOW + j] = 1
    const { texts } = run(c, p)
    expect(texts.map(t => t.text)).toEqual(['跳空涨', '跳空跌', '岛形顶'])
    const tip = createKPatternTooltipDataSource({
      indicator: { calcParams: p, result: calculateKPatterns(c) },
      crosshair: { dataIndex: 6 },
    })
    expect(tip.legends.map(v => v.title + v.value.text)).toEqual(['跳空下跌: 跳空跌', '岛形顶部: 岛形顶'])
  })
  it('registers as a price-pane overlay with no figures (does not stretch the Y axis)', () => {
    expect(kPatternIndicator.name).toBe('AICOIN_KPATTERN')
    expect(kPatternIndicator.series).toBe('price')
    expect(kPatternIndicator.figures).toEqual([])
  })
})

describe('AiCoin K线形态 — EDITABLE wiring', () => {
  it('params map 1:1 to defaults and survive sanitize', () => {
    const def = EDITABLE.find(d => d.name === 'AICOIN_KPATTERN')!
    expect(def.params.length === 52 || def.params.length === KP_DEFAULTS.length).toBe(true)
    expect(def.defaults).toEqual([...KP_DEFAULTS])
    expect(def.params.slice(0, 15).map(p => p.label)).toEqual(KP_PLOTS.map(p => p.title))
    const p = [...KP_DEFAULTS]; p[KP_COLOR + 3] = 0x123456; p[KP_ALERT + 14] = 1
    expect(sanitizeSettings({ AICOIN_KPATTERN: { params: p, visible: true } })['AICOIN_KPATTERN']).toEqual({
      params: p.slice(0, def.params.length),
      visible: true,
    })
  })
})
