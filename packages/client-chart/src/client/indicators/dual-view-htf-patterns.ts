/**
 * Dual View HTF Candlestick Patterns [theUltimator5] — TypeScript port of
 * pine/dual-view-htf-patterns.pine (MPL-2.0). Aggregates LTF bars into HTF
 * candles, detects reversal patterns with prior EMA/SMA trend, draws floating
 * HTF candles on the right and historical pattern candles on the chart.
 * doji_sensitivity is exposed (Pine input) but unused in the Pine body.
 */
import { formatPrice } from '../precision.js'
import { parseTimeframeSeconds } from './mtf-sr.js'

export interface DvCandle {
  open: number; high: number; low: number; close: number
  timestamp?: number
}

export const HTF_TF_OPTIONS = ['60', '120', '180', '240', '360', '480', '720', 'D', 'W', 'M'] as const
export const HTF_TF_LABELS = ['1H', '2H', '3H', '4H', '6H', '8H', '12H', '日线', '周线', '月线'] as const
export const PATTERN_FILTER_OPTS = ['全部', '仅2K', '仅3K'] as const
export const SIZE_OPTS = ['tiny', 'small', 'normal', 'large'] as const
export const TREND_OPTS = ['SMA', 'EMA'] as const

export const PATTERN_KEYS = [
  'evening_star', 'morning_star', 'shooting_star', 'hammer', 'inverted_hammer', 'hanging_man',
  'bearish_harami', 'bullish_harami', 'bearish_engulfing', 'bullish_engulfing',
  'piercing_line', 'dark_cloud_cover', 'bullish_kicker', 'bearish_kicker', 'bullish_belt',
  'three_inside_up', 'three_inside_down', 'three_outside_up', 'three_outside_down',
] as const
export type PatternKey = typeof PATTERN_KEYS[number]

/** Pine default: Harami off, rest on. Order matches PATTERN_KEYS. */
const PATTERN_DEFAULT_ON = [1, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]

export const PATTERN_CN: Record<PatternKey, string> = {
  evening_star: '黄昏之星', morning_star: '晨星', shooting_star: '射击之星', hammer: '锤子',
  inverted_hammer: '倒锤子', hanging_man: '上吊线', bearish_harami: '看跌孕线', bullish_harami: '看涨孕线',
  bearish_engulfing: '看跌吞没', bullish_engulfing: '看涨吞没', piercing_line: '刺透', dark_cloud_cover: '乌云盖顶',
  bullish_kicker: '看涨反冲', bearish_kicker: '看跌反冲', bullish_belt: '看涨捉腰带',
  three_inside_up: '三内部上涨', three_inside_down: '三内部下跌',
  three_outside_up: '三外部上涨', three_outside_down: '三外部下跌',
}

export const PATTERN_EN: Record<PatternKey, string> = {
  evening_star: 'Evening Star', morning_star: 'Morning Star', shooting_star: 'Shooting Star', hammer: 'Hammer',
  inverted_hammer: 'Inverted Hammer', hanging_man: 'Hanging Man', bearish_harami: 'Bearish Harami', bullish_harami: 'Bullish Harami',
  bearish_engulfing: 'Bearish Engulfing', bullish_engulfing: 'Bullish Engulfing', piercing_line: 'Piercing Line',
  dark_cloud_cover: 'Dark Cloud Cover', bullish_kicker: 'Bullish Kicker', bearish_kicker: 'Bearish Kicker',
  bullish_belt: 'Bullish Belt', three_inside_up: 'Three Inside Up', three_inside_down: 'Three Inside Down',
  three_outside_up: 'Three Outside Up', three_outside_down: 'Three Outside Down',
}

export const PATTERN_EXPLAIN: Record<string, string> = {
  Hammer: 'The hammer candlestick pattern is a bullish reversal signal appearing at the bottom of a downtrend, featuring a small body at the top and a long lower shadow at least twice the body\'s length. It indicates that sellers pushed prices down, but buyers surged to close near the open, signaling a potential shift to an uptrend. The following candle confirmed the reversal with bullish momentum.',
  'Inverted Hammer': 'The inverted hammer is a bullish reversal pattern appearing after a downtrend, characterized by a small body at the bottom and a long upper shadow. It shows that buyers attempted to push prices higher, but sellers regained control temporarily. The following bullish candle confirms the reversal, indicating buyers are gaining strength.',
  'Shooting Star': 'The shooting star is a bearish reversal pattern appearing after an uptrend, featuring a small body at the bottom with a long upper shadow. It indicates that buyers pushed prices higher during the session, but sellers drove the price back down near the open, suggesting weakening momentum. The following bearish candle confirmed the reversal.',
  'Hanging Man': 'The hanging man is a bearish reversal pattern appearing after an uptrend, with a small body at the top and a long lower shadow. It suggests that sellers pushed prices down during the session, though buyers managed to close near the open. The following bearish candle confirms that sellers are taking control and a downtrend may be starting.',
  'Morning Star': 'The morning star is a three-candle bullish reversal pattern appearing after a downtrend. It consists of a long bearish candle, followed by a small-bodied candle (showing indecision), and completed by a strong bullish candle that closes well into the first candle\'s body. This pattern signals that sellers are losing control and buyers are stepping in.',
  'Evening Star': 'The evening star is a three-candle bearish reversal pattern appearing after an uptrend. It consists of a long bullish candle, followed by a small-bodied candle (showing indecision), and completed by a strong bearish candle that closes well into the first candle\'s body. This pattern signals that buyers are losing control and sellers are taking over.',
  'Bullish Engulfing': 'The bullish engulfing pattern is a two-candle reversal formation appearing after a downtrend. The first candle is bearish, and the second is a larger bullish candle that completely engulfs the first candle\'s body. This shows a dramatic shift in sentiment as buyers overwhelm sellers, often signaling the start of an uptrend.',
  'Bearish Engulfing': 'The bearish engulfing pattern is a two-candle reversal formation appearing after an uptrend. The first candle is bullish, and the second is a larger bearish candle that completely engulfs the first candle\'s body. This shows a dramatic shift in sentiment as sellers overwhelm buyers, often signaling the start of a downtrend.',
  Piercing: 'The piercing line is a bullish reversal pattern appearing after a downtrend. It consists of a bearish candle followed by a bullish candle that opens below the prior low but closes above the midpoint of the previous candle\'s body. This demonstrates that buyers are stepping in with strength, potentially reversing the downtrend.',
  'Dark Cloud': 'The dark cloud cover is a bearish reversal pattern appearing after an uptrend. It consists of a bullish candle followed by a bearish candle that opens above the prior high but closes below the midpoint of the previous candle\'s body. This shows that sellers are stepping in with strength, potentially reversing the uptrend.',
  'Bullish Harami': 'The bullish harami is a reversal pattern where a small bullish candle appears completely within the body of the previous larger bearish candle. The name \'harami\' means pregnant in Japanese, as the small candle is \'inside\' the larger one. This pattern suggests indecision and potential trend reversal as selling pressure weakens.',
  'Bearish Harami': 'The bearish harami is a reversal pattern where a small bearish candle appears completely within the body of the previous larger bullish candle. The name \'harami\' means pregnant in Japanese, as the small candle is \'inside\' the larger one. This pattern suggests indecision and potential trend reversal as buying pressure weakens.',
  'Bullish Kicker': 'The bullish kicker is a powerful two-candle reversal pattern appearing after a downtrend. It consists of a bearish candle followed by a bullish candle that gaps up and opens at or above the previous candle\'s open. This dramatic gap and strong bullish move indicates a sudden and forceful shift from selling to buying pressure.',
  'Bearish Kicker': 'The bearish kicker is a powerful two-candle reversal pattern appearing after an uptrend. It consists of a bullish candle followed by a bearish candle that gaps down and opens at or below the previous candle\'s open. This dramatic gap and strong bearish move indicates a sudden and forceful shift from buying to selling pressure.',
  'Three Inside Up': 'The three inside up is a bullish reversal pattern that extends the bullish harami. The first candle is bearish, the second is a smaller bullish candle contained within the first (forming a harami), and the third candle closes green above the second candle\'s close. This confirms the reversal as buyers gain momentum after the indecision.',
  'Three Inside Down': 'The three inside down is a bearish reversal pattern that extends the bearish harami. The first candle is bullish, the second is a smaller bearish candle contained within the first (forming a harami), and the third candle closes red below the second candle\'s close. This confirms the reversal as sellers gain momentum after the indecision.',
  'Three Outside Up': 'The three outside up is a bullish reversal pattern that extends the bullish engulfing pattern. The first candle is bearish, the second is a larger bullish candle that engulfs the first, and the third candle closes above the second candle\'s close. This strong three-candle advance confirms powerful buying pressure and trend reversal.',
  'Three Outside Down': 'The three outside down is a bearish reversal pattern that extends the bearish engulfing pattern. The first candle is bullish, the second is a larger bearish candle that engulfs the first, and the third candle closes below the second candle\'s close. This strong three-candle decline confirms powerful selling pressure and trend reversal.',
  'Bullish Belt': 'Bullish belt hold: opens at the low (no lower wick) below the prior range and closes strongly into the prior candle\'s range.',
}

export function getPatternExplanation(patternText: string): string {
  for (const [k, v] of Object.entries(PATTERN_EXPLAIN)) {
    if (patternText.includes(k)) return v
  }
  return 'Candlestick pattern detected on higher timeframe candles.'
}

export const hexToInt = (hex: string): number => parseInt(hex.replace('#', ''), 16)
export const intToHex = (n: number): string => '#' + Math.max(0, Math.min(0xFFFFFF, Math.round(n))).toString(16).padStart(6, '0').toUpperCase()
const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

const COL = {
  lime: '#00FF00', red: '#FF0000', bearLine: '#FF7878', yellow: '#FFFF00', white: '#FFFFFF', gray: '#808080',
}

/** Param indices — keep in sync with EDITABLE in ChartCard. */
export const DV_DEFAULTS = [
  7, 7, 10, 3, 20, 200, 1, 1, // 0-7 tf(D),num,w,sp,off,lookback,float,hist
  hexToInt(COL.lime), hexToInt(COL.lime), hexToInt(COL.red), hexToInt(COL.bearLine), // 8-11 fills/lines
  98, 2, // 12-13 transp, thick
  0, hexToInt(COL.yellow), 2, 1, 12, // 14-18 trend, maColor, maW, method EMA, len
  0, // 19 filter All
  ...PATTERN_DEFAULT_ON, // 20-38
  1, 1, // 39-40 textSize small, info markers
  hexToInt(COL.lime), hexToInt(COL.red), // 41-42 label colors
  0.05, // 43 doji (unused in Pine body)
  1, hexToInt(COL.white), 2, 3, // 44-47 center label
  0, hexToInt(COL.gray), 1, // 48-50 horiz
  0, // 51 alert
]

export interface DvParams {
  htfTf: string
  numCandles: number
  candleWidth: number
  spacing: number
  offset: number
  lookback: number
  showFloating: boolean
  showHist: boolean
  bullFill: string; bullLine: string; bearFill: string; bearLine: string
  bodyTransp: number
  lineThick: number
  showTrend: boolean
  maColor: string
  maWidth: number
  trendMethod: 'SMA' | 'EMA'
  maLength: number
  filter: 0 | 1 | 2
  show: Record<PatternKey, boolean>
  textSize: number
  showInfo: boolean
  labelBull: string; labelBear: string
  dojiSensitivity: number
  showCenter: boolean
  centerColor: string
  centerSize: number
  centerOffset: number
  showHoriz: boolean
  horizColor: string
  horizWidth: number
  alertOn: boolean
}

const intIn = (v: unknown, d: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : d
const numIn = (v: unknown, d: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : d

export function sanitizeDvParams(p: readonly unknown[] = []): DvParams {
  const D = DV_DEFAULTS
  const show = {} as Record<PatternKey, boolean>
  PATTERN_KEYS.forEach((k, i) => { show[k] = intIn(p[20 + i], PATTERN_DEFAULT_ON[i]!, 0, 1) === 1 })
  const tfIdx = intIn(p[0], 7, 0, HTF_TF_OPTIONS.length - 1)
  return {
    htfTf: HTF_TF_OPTIONS[tfIdx]!,
    numCandles: intIn(p[1], 7, 1, 10),
    candleWidth: intIn(p[2], 10, 1, 100),
    spacing: intIn(p[3], 3, 0, 50),
    offset: intIn(p[4], 20, 0, 200),
    lookback: intIn(p[5], 200, 10, 300),
    showFloating: intIn(p[6], 1, 0, 1) === 1,
    showHist: intIn(p[7], 1, 0, 1) === 1,
    bullFill: intToHex(intIn(p[8], D[8]!, 0, 0xFFFFFF)),
    bullLine: intToHex(intIn(p[9], D[9]!, 0, 0xFFFFFF)),
    bearFill: intToHex(intIn(p[10], D[10]!, 0, 0xFFFFFF)),
    bearLine: intToHex(intIn(p[11], D[11]!, 0, 0xFFFFFF)),
    bodyTransp: intIn(p[12], 98, 0, 100),
    lineThick: intIn(p[13], 2, 1, 10),
    showTrend: intIn(p[14], 0, 0, 1) === 1,
    maColor: intToHex(intIn(p[15], D[15]!, 0, 0xFFFFFF)),
    maWidth: intIn(p[16], 2, 1, 5),
    trendMethod: TREND_OPTS[intIn(p[17], 1, 0, 1)] as 'SMA' | 'EMA',
    maLength: intIn(p[18], 12, 1, 200),
    filter: intIn(p[19], 0, 0, 2) as 0 | 1 | 2,
    show,
    textSize: intIn(p[39], 1, 0, 3),
    showInfo: intIn(p[40], 1, 0, 1) === 1,
    labelBull: intToHex(intIn(p[41], D[41]!, 0, 0xFFFFFF)),
    labelBear: intToHex(intIn(p[42], D[42]!, 0, 0xFFFFFF)),
    dojiSensitivity: numIn(p[43], 0.05, 0.01, 0.5),
    showCenter: intIn(p[44], 1, 0, 1) === 1,
    centerColor: intToHex(intIn(p[45], D[45]!, 0, 0xFFFFFF)),
    centerSize: intIn(p[46], 2, 0, 3),
    centerOffset: intIn(p[47], 3, 0, 20),
    showHoriz: intIn(p[48], 0, 0, 1) === 1,
    horizColor: intToHex(intIn(p[49], D[49]!, 0, 0xFFFFFF)),
    horizWidth: intIn(p[50], 1, 1, 5),
    alertOn: intIn(p[51], 0, 0, 1) === 1,
  }
}

export function getTimeframeLabel(tf: string): string {
  if (tf === 'D' || tf === '1D') return 'Daily'
  if (tf === 'W' || tf === '1W') return 'Weekly'
  if (tf === 'M' || tf === '1M') return 'Monthly'
  if (tf === '60') return '1H'
  if (tf === '120') return '2H'
  if (tf === '180') return '3H'
  if (tf === '240') return '4H'
  if (tf === '360') return '6H'
  if (tf === '480') return '8H'
  if (tf === '720') return '12H'
  return tf
}

/** Period bucket start (ms) for timeframe.change-style aggregation. UTC. */
export function htfBucketStart(tsMs: number, tf: string): number {
  const d = new Date(tsMs)
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate()
  if (tf === 'D' || tf === '1D') return Date.UTC(y, m, day)
  if (tf === 'W' || tf === '1W') {
    const dow = d.getUTCDay()
    const mondayOffset = (dow + 6) % 7
    return Date.UTC(y, m, day - mondayOffset)
  }
  if (tf === 'M' || tf === '1M') return Date.UTC(y, m, 1)
  const mins = parseInt(tf, 10)
  if (Number.isFinite(mins) && mins > 0) {
    const slot = mins * 60_000
    return Math.floor(tsMs / slot) * slot
  }
  const sec = parseTimeframeSeconds(tf)
  const slot = sec * 1000
  return Math.floor(tsMs / slot) * slot
}

export interface HtfBar {
  open: number; high: number; low: number; close: number
  highBar: number; lowBar: number; startBar: number; endBar: number
  startTime: number; endTime: number
  ma?: number | undefined
  forming?: boolean | undefined
}

export function aggregateHtf(candles: readonly DvCandle[], tf: string): { completed: HtfBar[]; current?: HtfBar | undefined } {
  const completed: HtfBar[] = []
  let cur: HtfBar | undefined
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!
    const ts = c.timestamp ?? i
    const buck = htfBucketStart(ts, tf)
    if (!cur || htfBucketStart(cur.startTime, tf) !== buck) {
      if (cur) completed.push({ ...cur, forming: false })
      cur = {
        open: c.open, high: c.high, low: c.low, close: c.close,
        highBar: i, lowBar: i, startBar: i, endBar: i,
        startTime: ts, endTime: ts, forming: true,
      }
    } else {
      if (c.high > cur.high) { cur.high = c.high; cur.highBar = i }
      if (c.low < cur.low) { cur.low = c.low; cur.lowBar = i }
      cur.close = c.close
      cur.endBar = i
      cur.endTime = ts
    }
  }
  return { completed, current: cur }
}

function smaArr(src: number[], len: number): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(src.length).fill(undefined)
  let s = 0
  for (let i = 0; i < src.length; i++) {
    s += src[i]!
    if (i >= len) s -= src[i - len]!
    if (i >= len - 1) out[i] = s / len
  }
  return out
}

function emaArr(src: number[], len: number): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(src.length).fill(undefined)
  const a = 2 / (len + 1)
  let prev: number | undefined
  let buf: number[] = []
  for (let i = 0; i < src.length; i++) {
    const v = src[i]!
    if (prev === undefined) {
      buf.push(v)
      if (buf.length === len) {
        prev = buf.reduce((x, y) => x + y, 0) / len
        out[i] = prev
        buf = []
      }
      continue
    }
    prev = a * v + (1 - a) * prev
    out[i] = prev
  }
  return out
}

export function attachHtfMa(bars: HtfBar[], method: 'SMA' | 'EMA', len: number): void {
  const closes = bars.map(b => b.close)
  const ma = method === 'EMA' ? emaArr(closes, len) : smaArr(closes, len)
  for (let i = 0; i < bars.length; i++) {
    const v = ma[i]
    if (v !== undefined) bars[i]!.ma = v
  }
}

type OHLC = { o: number; h: number; l: number; c: number; ma?: number | undefined }

function getAt(bars: readonly HtfBar[], fromEnd: number): OHLC | undefined {
  const i = bars.length - 1 - fromEnd
  if (i < 0 || i >= bars.length) return undefined
  const b = bars[i]!
  return { o: b.open, h: b.high, l: b.low, c: b.close, ma: b.ma }
}

/** Exact Pine detect_pattern_at_index. candleIndex=0 is newest completed HTF. */
export function detectPatternAtIndex(
  bars: readonly HtfBar[],
  candleIndex: number,
  P: DvParams,
): { found: boolean; text: string; keys: PatternKey[] } {
  const keys: PatternKey[] = []
  if (bars.length <= candleIndex + 1) return { found: false, text: '', keys }
  const c0 = getAt(bars, candleIndex)
  const c1 = getAt(bars, candleIndex + 1)
  if (!c0 || !c1) return { found: false, text: '', keys }
  const c2 = getAt(bars, candleIndex + 2)
  const ma2 = getAt(bars, candleIndex + 2)?.ma
  const ma3 = getAt(bars, candleIndex + 3)?.ma
  const ma4 = getAt(bars, candleIndex + 4)?.ma
  const prior_uptrend_2 = ma2 !== undefined && ma3 !== undefined && ma2 > ma3
  const prior_downtrend_2 = ma2 !== undefined && ma3 !== undefined && ma2 < ma3
  const prior_uptrend_3 = ma3 !== undefined && ma4 !== undefined && ma3 > ma4
  const prior_downtrend_3 = ma3 !== undefined && ma4 !== undefined && ma3 < ma4
  const is_all_or_2 = P.filter === 0 || P.filter === 1
  const is_all_or_3 = P.filter === 0 || P.filter === 2
  const htf_upper = Math.max(c0.h, c1.h)
  const htf_lower = Math.min(c0.l, c1.l)
  const { o: htf_o, h: htf_h, l: htf_l, c: htf_c } = c0
  const { o: htf_o1, h: htf_h1, l: htf_l1, c: htf_c1 } = c1
  const htf_o2 = c2?.o, htf_h2 = c2?.h, htf_l2 = c2?.l, htf_c2 = c2?.c

  const add = (on: boolean, key: PatternKey) => { if (on) keys.push(key) }

  add(P.show.evening_star && is_all_or_3 && c2 !== undefined &&
    htf_c2! > htf_o2! && (htf_c2! - htf_o2!) > 10 * Math.abs(htf_c1 - htf_o1) &&
    (htf_o - htf_c) > 10 * Math.abs(htf_c1 - htf_o1) && htf_c < htf_o &&
    htf_c < (htf_o2! + (htf_c2! - htf_o2!) / 2) && htf_o < htf_c1 && prior_uptrend_3, 'evening_star')

  add(P.show.morning_star && is_all_or_3 && c2 !== undefined &&
    htf_c2! < htf_o2! && (htf_o2! - htf_c2!) > 10 * Math.abs(htf_c1 - htf_o1) &&
    (htf_c - htf_o) > 10 * Math.abs(htf_c1 - htf_o1) && htf_c > htf_o &&
    htf_c > (htf_c2! + (htf_o2! - htf_c2!) / 2) && htf_o > htf_c1 && prior_downtrend_3, 'morning_star')

  add(P.show.shooting_star && is_all_or_2 &&
    (htf_h1 - Math.max(htf_o1, htf_c1)) >= Math.abs(htf_o1 - htf_c1) * 2 &&
    Math.min(htf_c1, htf_o1) - htf_l1 <= Math.abs(htf_o1 - htf_c1) * 0.1 &&
    prior_uptrend_2 && htf_o > htf_c, 'shooting_star')

  add(P.show.hammer && is_all_or_2 &&
    (htf_h1 - htf_l1) > 3 * Math.abs(htf_o1 - htf_c1) &&
    (htf_c1 - htf_l1) / (0.001 + htf_h1 - htf_l1) > 0.6 &&
    (htf_o1 - htf_l1) / (0.001 + htf_h1 - htf_l1) > 0.6 &&
    prior_downtrend_2 && htf_c > htf_o, 'hammer')

  add(P.show.inverted_hammer && is_all_or_2 &&
    (htf_h1 - htf_l1) > 3 * Math.abs(htf_o1 - htf_c1) &&
    (htf_h1 - htf_c1) / (0.001 + htf_h1 - htf_l1) > 0.6 &&
    (htf_h1 - htf_o1) / (0.001 + htf_h1 - htf_l1) > 0.6 &&
    prior_downtrend_2 && htf_c > htf_o, 'inverted_hammer')

  add(P.show.bearish_harami && is_all_or_2 &&
    htf_c1 > htf_o1 && htf_o > htf_c && htf_o <= htf_c1 && htf_o1 <= htf_c &&
    htf_o - htf_c < htf_c1 - htf_o1 && prior_uptrend_2, 'bearish_harami')

  add(P.show.bullish_harami && is_all_or_2 &&
    htf_o1 > htf_c1 && htf_c > htf_o && htf_c <= htf_o1 && htf_c1 <= htf_o &&
    htf_c - htf_o < htf_o1 - htf_c1 && prior_downtrend_2, 'bullish_harami')

  add(P.show.bearish_engulfing && is_all_or_2 &&
    htf_c1 > htf_o1 && htf_o > htf_c && htf_o >= htf_c1 && htf_o1 >= htf_c &&
    htf_o - htf_c > htf_c1 - htf_o1 && prior_uptrend_2, 'bearish_engulfing')

  add(P.show.bullish_engulfing && is_all_or_2 &&
    htf_o1 > htf_c1 && htf_c > htf_o && htf_c >= htf_o1 && htf_c1 >= htf_o &&
    htf_c - htf_o > htf_o1 - htf_c1 && prior_downtrend_2, 'bullish_engulfing')

  add(P.show.piercing_line && is_all_or_2 &&
    htf_c1 < htf_o1 && htf_o < htf_l1 &&
    htf_c > htf_c1 + ((htf_o1 - htf_c1) / 2) && htf_c < htf_o1 && prior_downtrend_2, 'piercing_line')

  add(P.show.bullish_belt && is_all_or_2 &&
    htf_l === htf_o && htf_o < htf_lower && htf_o < htf_c &&
    htf_c > ((htf_h1 - htf_l1) / 2) + htf_l1, 'bullish_belt')

  add(P.show.bullish_kicker && is_all_or_2 &&
    htf_o1 > htf_c1 && htf_o >= htf_o1 && htf_c > htf_o && prior_downtrend_2, 'bullish_kicker')

  add(P.show.bearish_kicker && is_all_or_2 &&
    htf_o1 < htf_c1 && htf_o <= htf_o1 && htf_c <= htf_o && prior_uptrend_2, 'bearish_kicker')

  add(P.show.hanging_man && is_all_or_2 &&
    (htf_h1 - htf_l1 > 3 * Math.abs(htf_o1 - htf_c1)) &&
    ((htf_c1 - htf_l1) / (0.001 + htf_h1 - htf_l1) >= 0.6) &&
    ((htf_o1 - htf_l1) / (0.001 + htf_h1 - htf_l1) >= 0.6) &&
    prior_uptrend_2 && htf_o > htf_c, 'hanging_man')

  add(P.show.dark_cloud_cover && is_all_or_2 &&
    htf_c1 > htf_o1 && ((htf_c1 + htf_o1) / 2) > htf_c &&
    htf_o > htf_c && htf_o > htf_c1 && htf_c > htf_o1 &&
    ((htf_o - htf_c) / (0.001 + (htf_h - htf_l)) > 0.6) && prior_uptrend_2, 'dark_cloud_cover')

  add(P.show.three_inside_up && is_all_or_3 && c2 !== undefined &&
    htf_o2! > htf_c2! && htf_c1 > htf_o1 &&
    htf_c1 <= htf_o2! && htf_o1 >= htf_c2! &&
    htf_c1 - htf_o1 < htf_o2! - htf_c2! &&
    htf_c > htf_o && htf_c > htf_c1 && prior_downtrend_3, 'three_inside_up')

  add(P.show.three_inside_down && is_all_or_3 && c2 !== undefined &&
    htf_c2! > htf_o2! && htf_o1 > htf_c1 &&
    htf_o1 <= htf_c2! && htf_c1 >= htf_o2! &&
    htf_o1 - htf_c1 < htf_c2! - htf_o2! &&
    htf_o > htf_c && htf_c < htf_c1 && prior_uptrend_3, 'three_inside_down')

  add(P.show.three_outside_up && is_all_or_3 && c2 !== undefined &&
    htf_o2! > htf_c2! && htf_c1 > htf_o1 &&
    htf_c1 >= htf_o2! && htf_c2! >= htf_o1 &&
    htf_c1 - htf_o1 > htf_o2! - htf_c2! &&
    htf_c > htf_c1 && prior_downtrend_3, 'three_outside_up')

  add(P.show.three_outside_down && is_all_or_3 && c2 !== undefined &&
    htf_c2! > htf_o2! && htf_o1 > htf_c1 &&
    htf_o1 >= htf_c2! && htf_o2! >= htf_c1 &&
    htf_o1 - htf_c1 > htf_c2! - htf_o2! &&
    htf_c < htf_c1 && prior_uptrend_3, 'three_outside_down')

  void htf_h2; void htf_l2; void htf_upper // reserved parity with Pine locals
  const text = keys.map(k => PATTERN_EN[k]).join('\n')
  return { found: keys.length > 0, text, keys }
}

export function patternCandleCount(patternText: string): number {
  if (/Evening Star|Morning Star|Three Inside Up|Three Inside Down|Three Outside Up|Three Outside Down/.test(patternText)) return 3
  if (/Shooting Star|Harami|Engulfing|Piercing|Belt|Kicker|Hanging Man|Dark Cloud|Hammer|Inverted Hammer/.test(patternText)) return 2
  return 1
}

export function isBullishPatternText(t: string): boolean {
  return /Morning Star|Hammer|Bullish|Piercing|Three Inside Up|Three Outside Up/.test(t)
}
export function isBearishPatternText(t: string): boolean {
  return /Evening Star|Shooting Star|Bearish|Hanging Man|Dark Cloud|Three Inside Down|Three Outside Down/.test(t)
}

export interface DvFloatCandle {
  o: number; h: number; l: number; c: number
  highBar: number; lowBar: number
  inPattern: boolean
  arrayIndex: number // -1 = forming
}

export interface DvHistPattern {
  text: string
  keys: PatternKey[]
  candles: { o: number; h: number; l: number; c: number; startBar: number; endBar: number; startTime: number; endTime: number }[]
  labelBar: number
  labelHigh: number
}

export interface DvRow {
  ma?: number | undefined
  /** Populated on the last bar only (drawing payload). */
  float?: DvFloatCandle[] | undefined
  patterns?: { found: boolean; text: string; keys: PatternKey[] }[] | undefined
  hist?: DvHistPattern[] | undefined
  alertText?: string | undefined
  htfLabel?: string | undefined
  completedCount?: number | undefined
}

export function calculateDualViewHtf(
  candles: readonly DvCandle[],
  params: readonly unknown[] = [],
  _sourceTf?: string,
): DvRow[] {
  const P = sanitizeDvParams(params)
  const rows: DvRow[] = candles.map(() => ({}))
  if (candles.length === 0) return rows

  const { completed, current } = aggregateHtf(candles, P.htfTf)
  // MA: Pine request.security on HTF — compute on completed + forming as live series
  const allForMa = current ? [...completed, current] : [...completed]
  attachHtfMa(allForMa, P.trendMethod, P.maLength)
  // Completed slice keeps MA; forming MA used for stepline only
  const completedWithMa = allForMa.slice(0, completed.length)
  const forming = current ? allForMa[allForMa.length - 1] : undefined

  // Stepline MA: paint each HTF bucket's MA across its LTF bars
  for (const b of completedWithMa) {
    if (b.ma === undefined) continue
    for (let i = b.startBar; i <= b.endBar; i++) rows[i]!.ma = b.ma
  }
  if (forming?.ma !== undefined) {
    for (let i = forming.startBar; i <= forming.endBar; i++) rows[i]!.ma = forming.ma
  }

  const maxCheck = Math.min(
    forming ? P.numCandles - 1 : P.numCandles,
    completedWithMa.length,
  )
  const patterns: { found: boolean; text: string; keys: PatternKey[] }[] = []
  const inPattern = new Array(Math.max(0, maxCheck)).fill(false)
  for (let idx = 0; idx < maxCheck; idx++) {
    const d = detectPatternAtIndex(completedWithMa, idx, P)
    patterns.push(d)
    if (d.found) {
      const n = patternCandleCount(d.text)
      for (let o = 0; o < n; o++) {
        if (idx + o < inPattern.length) inPattern[idx + o] = true
      }
    }
  }

  const floatCandles: DvFloatCandle[] = []
  if (P.showFloating) {
    for (let i = 0; i < P.numCandles; i++) {
      if (i === 0 && forming) {
        floatCandles.push({
          o: forming.open, h: forming.high, l: forming.low, c: forming.close,
          highBar: forming.highBar, lowBar: forming.lowBar, inPattern: false, arrayIndex: -1,
        })
      } else {
        const arrayOffset = forming ? i - 1 : i
        const arrayIndex = completedWithMa.length - 1 - arrayOffset
        if (arrayIndex >= 0 && arrayIndex < completedWithMa.length) {
          const b = completedWithMa[arrayIndex]!
          floatCandles.push({
            o: b.open, h: b.high, l: b.low, c: b.close,
            highBar: b.highBar, lowBar: b.lowBar,
            inPattern: arrayOffset >= 0 && arrayOffset < inPattern.length ? inPattern[arrayOffset]! : false,
            arrayIndex: arrayOffset,
          })
        } else {
          floatCandles.push({ o: NaN, h: NaN, l: NaN, c: NaN, highBar: 0, lowBar: 0, inPattern: false, arrayIndex: arrayOffset })
        }
      }
    }
  }

  const hist: DvHistPattern[] = []
  if (P.showHist) {
    const historicalMax = Math.min(P.lookback, completedWithMa.length)
    for (let candleIdx = 0; candleIdx < historicalMax; candleIdx++) {
      const d = detectPatternAtIndex(completedWithMa, candleIdx, P)
      if (!d.found) continue
      const n = patternCandleCount(d.text)
      const pcs: DvHistPattern['candles'] = []
      for (let off = n - 1; off >= 0; off--) {
        const historicalIdx = candleIdx + off
        if (historicalIdx >= completedWithMa.length) continue
        const dataIdx = completedWithMa.length - 1 - historicalIdx
        const b = completedWithMa[dataIdx]!
        pcs.push({
          o: b.open, h: b.high, l: b.low, c: b.close,
          startBar: b.startBar, endBar: b.endBar, startTime: b.startTime, endTime: b.endTime,
        })
      }
      const labelDataIdx = completedWithMa.length - 1 - candleIdx
      const lb = completedWithMa[labelDataIdx]!
      hist.push({ text: d.text, keys: d.keys, candles: pcs, labelBar: Math.round((lb.startBar + lb.endBar) / 2), labelHigh: lb.high })
    }
  }

  let alertText: string | undefined
  if (patterns[0]?.found) {
    alertText = `${getTimeframeLabel(P.htfTf)} Pattern Detected: ${patterns[0].text}`
  }

  const last = rows[rows.length - 1]!
  last.float = floatCandles
  last.patterns = patterns
  last.hist = hist
  last.alertText = alertText
  last.htfLabel = getTimeframeLabel(P.htfTf)
  last.completedCount = completedWithMa.length
  return rows
}

export function dvAlertEvents(
  candles: readonly { time?: string; timestamp?: number; open: number; high: number; low: number; close: number }[],
  params: readonly number[],
  sourceTf?: string,
): { id: string; text: string }[] {
  const P = sanitizeDvParams(params)
  if (!P.alertOn || candles.length < 2) return []
  const mapped: DvCandle[] = candles.map((c, i) => ({
    open: c.open, high: c.high, low: c.low, close: c.close,
    timestamp: c.timestamp ?? (c.time ? Date.parse(c.time) : i),
  }))
  const rows = calculateDualViewHtf(mapped, params, sourceTf)
  const last = rows[rows.length - 1]
  if (!last?.alertText || !last.patterns?.[0]?.found) return []
  // Anchor id to newest completed HTF end time
  const { completed, current } = aggregateHtf(mapped, P.htfTf)
  const newest = completed[completed.length - 1]
  if (!newest) return []
  // Only alert once the HTF bar that completed is "locked" (a forming bar exists after it)
  if (!current) return []
  return [{ id: `${newest.endTime}|${last.alertText}`, text: last.alertText }]
}

const fontSize = (sz: number) => [9, 11, 13, 15][sz] ?? 11

function drawCandle(
  ctx: CanvasRenderingContext2D,
  X: (i: number) => number,
  Y: (v: number) => number,
  left: number, right: number,
  o: number, h: number, l: number, c: number,
  fill: string, line: string, transp: number, thick: number,
) {
  const x1 = X(left), x2 = X(right)
  const cx = (x1 + x2) / 2
  const top = Math.max(o, c), bot = Math.min(o, c)
  const bodyT = Y(top), bodyB = Y(bot)
  const w = Math.max(2, x2 - x1)
  ctx.fillStyle = rgba(fill, 1 - transp / 100)
  ctx.strokeStyle = line
  ctx.lineWidth = thick
  ctx.fillRect(x1, Math.min(bodyT, bodyB), w, Math.max(1, Math.abs(bodyB - bodyT)))
  ctx.strokeRect(x1, Math.min(bodyT, bodyB), w, Math.max(1, Math.abs(bodyB - bodyT)))
  const tol = (h - l) * 1e-6
  ctx.beginPath()
  if (h > top + tol) { ctx.moveTo(cx, Y(top)); ctx.lineTo(cx, Y(h)) }
  if (l < bot - tol) { ctx.moveTo(cx, Y(bot)); ctx.lineTo(cx, Y(l)) }
  ctx.stroke()
}

export const dualViewHtfIndicator = {
  name: 'DUAL_VIEW_HTF',
  shortName: 'HTF形态',
  series: 'price' as const,
  precision: 2,
  calcParams: [...DV_DEFAULTS],
  figures: [] as { key: string }[],
  calc: (dataList: DvCandle[], indicator?: { calcParams?: number[]; extendData?: { sourceTimeframe?: string } }) =>
    calculateDualViewHtf(dataList, indicator?.calcParams ?? [], indicator?.extendData?.sourceTimeframe),
  createTooltipDataSource: ({ indicator, crosshair }: {
    indicator: { calcParams: number[]; result: DvRow[] }
    crosshair: { dataIndex?: number }
  }) => {
    const P = sanitizeDvParams(indicator.calcParams)
    const last = indicator.result[indicator.result.length - 1]
    const i = crosshair.dataIndex ?? indicator.result.length - 1
    const r = indicator.result[i]
    const tag = (text: string, color: string) => ({ title: { text: '', color }, value: { text, color } })
    const values = [
      tag(`HTF ${getTimeframeLabel(P.htfTf)}`, P.centerColor),
      ...(r?.ma !== undefined ? [{ title: { text: 'MA: ', color: P.maColor }, value: { text: formatPrice(r.ma), color: P.maColor } }] : []),
      ...(last?.patterns?.[0]?.found ? [tag(last.patterns[0].text.replace(/\n/g, ' · '), P.labelBull)] : [tag('无最新完成K形态', P.centerColor)]),
      tag(`完成HTF: ${last?.completedCount ?? 0}`, P.centerColor),
    ]
    return { name: '双视HTF形态', calcParamsText: `(${P.htfTf},${P.numCandles})`, values }
  },
  draw: ({ ctx, indicator, xAxis, yAxis, visibleRange, kLineDataList }: {
    ctx: CanvasRenderingContext2D
    indicator: { result: DvRow[]; calcParams: number[] }
    xAxis: { convertToPixel: (v: number) => number }
    yAxis: { convertToPixel: (v: number) => number }
    visibleRange: { from: number; to: number }
    bounding: { height: number; width: number }
    kLineDataList: { high?: number; low?: number; timestamp?: number }[]
  }) => {
    const rows = indicator.result
    if (!rows.length) return false
    const P = sanitizeDvParams(indicator.calcParams)
    const lastIdx = rows.length - 1
    const last = rows[lastIdx]!
    const X = (i: number) => xAxis.convertToPixel(i)
    const Y = (v: number) => yAxis.convertToPixel(v)
    ctx.save()

    // Trend stepline
    if (P.showTrend) {
      ctx.beginPath()
      let pen = false
      let prev: number | undefined
      const from = Math.max(0, visibleRange.from)
      const to = Math.min(lastIdx, visibleRange.to)
      for (let i = from; i <= to; i++) {
        const m = rows[i]?.ma
        if (m === undefined) { pen = false; prev = undefined; continue }
        if (!pen) { ctx.moveTo(X(i), Y(m)); pen = true }
        else {
          // stepline: horizontal then vertical
          ctx.lineTo(X(i), Y(prev!))
          ctx.lineTo(X(i), Y(m))
        }
        prev = m
      }
      ctx.strokeStyle = P.maColor
      ctx.lineWidth = P.maWidth
      ctx.stroke()
    }

    // Historical pattern candles
    if (P.showHist && last.hist) {
      for (const hp of last.hist) {
        for (const c of hp.candles) {
          const bull = c.c >= c.o
          drawCandle(ctx, X, Y, c.startBar, c.endBar, c.o, c.h, c.l, c.c,
            bull ? P.bullFill : P.bearFill, bull ? P.bullLine : P.bearLine, P.bodyTransp, P.lineThick)
        }
        const col = isBullishPatternText(hp.text) ? P.labelBull : isBearishPatternText(hp.text) ? P.labelBear : P.centerColor
        ctx.fillStyle = col
        ctx.font = `${fontSize(P.textSize)}px sans-serif`
        ctx.textAlign = 'center'
        const lines = hp.text.split('\n')
        lines.forEach((ln, li) => ctx.fillText(ln, X(hp.labelBar), Y(hp.labelHigh) - 4 - li * (fontSize(P.textSize) + 2)))
        if (P.showInfo) {
          ctx.fillStyle = rgba('#808080', 0.7)
          ctx.font = '10px sans-serif'
          ctx.fillText('ⓘ', X(hp.labelBar), Y(hp.labelHigh) - 4 - lines.length * (fontSize(P.textSize) + 2) - 2)
        }
      }
    }

    // Floating HTF candles to the right of last bar
    if (P.showFloating && last.float && last.float.length) {
      let lowest = Infinity, highest = -Infinity
      for (let i = 0; i < last.float.length; i++) {
        const fc = last.float[i]!
        if (!Number.isFinite(fc.o)) continue
        const positionIndex = P.numCandles - 1 - i
        const off = P.offset + positionIndex * (P.candleWidth + P.spacing)
        const left = lastIdx + 1 + off
        const right = left + P.candleWidth
        const bull = fc.c >= fc.o
        const transp = fc.inPattern ? 20 : P.bodyTransp
        drawCandle(ctx, X, Y, left, right, fc.o, fc.h, fc.l, fc.c,
          bull ? P.bullFill : P.bearFill, bull ? P.bullLine : P.bearLine, transp, P.lineThick)
        if (fc.l < lowest) lowest = fc.l
        if (fc.h > highest) highest = fc.h

        if (P.showHoriz && Number.isFinite(fc.h)) {
          ctx.beginPath()
          ctx.setLineDash([3, 3])
          ctx.strokeStyle = P.horizColor
          ctx.lineWidth = P.horizWidth
          ctx.moveTo(X(fc.highBar), Y(fc.h))
          ctx.lineTo(X((left + right) / 2), Y(fc.h))
          ctx.moveTo(X(fc.lowBar), Y(fc.l))
          ctx.lineTo(X((left + right) / 2), Y(fc.l))
          ctx.stroke()
          ctx.setLineDash([])
        }
      }

      // Center TF label
      if (P.showCenter && Number.isFinite(lowest)) {
        const half = Math.floor(P.numCandles / 2)
        let centerX: number
        if (P.numCandles % 2 === 1) {
          const pos = P.numCandles - 1 - half
          const off = P.offset + pos * (P.candleWidth + P.spacing)
          const cl = lastIdx + 1 + off
          centerX = cl + P.candleWidth / 2
        } else {
          const posL = P.numCandles - half
          const posR = P.numCandles - half - 1
          const offL = P.offset + posL * (P.candleWidth + P.spacing)
          const offR = P.offset + posR * (P.candleWidth + P.spacing)
          const crL = lastIdx + 1 + offL + P.candleWidth
          const clR = lastIdx + 1 + offR
          centerX = (crL + clR) / 2
        }
        const lastBar = kLineDataList[lastIdx]
        const priceRange = (lastBar?.high ?? highest) - (lastBar?.low ?? lowest)
        const offsetPrice = priceRange * P.centerOffset / 100
        ctx.fillStyle = P.centerColor
        ctx.font = `${fontSize(P.centerSize)}px sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText(last.htfLabel ?? getTimeframeLabel(P.htfTf), X(centerX), Y(lowest - offsetPrice))
      }

      // Floating pattern labels
      if (last.patterns) {
        const lastBar = kLineDataList[lastIdx]
        const priceRange = (lastBar?.high ?? highest) - (lastBar?.low ?? (lowest || 0))
        const offsetPrice = priceRange * P.centerOffset / 100
        for (let candleIdx = 0; candleIdx < last.patterns.length; candleIdx++) {
          const pat = last.patterns[candleIdx]!
          if (!pat.found) continue
          const patternI = (last.float[0] && last.float[0].arrayIndex === -1) ? candleIdx + 1 : candleIdx
          const patternPosition = P.numCandles - 1 - patternI
          const pOff = P.offset + patternPosition * (P.candleWidth + P.spacing)
          const pLeft = lastIdx + 1 + pOff
          const pCenter = pLeft + P.candleWidth / 2
          const fc = last.float.find(f => f.arrayIndex === candleIdx)
          const candleHigh = fc && Number.isFinite(fc.h) ? fc.h : highest
          // Pine floating pattern labels use center_label_size (not pattern_text_size)
          const col = isBullishPatternText(pat.text) ? P.labelBull : isBearishPatternText(pat.text) ? P.labelBear : P.centerColor
          const floatLblPx = fontSize(P.centerSize)
          ctx.fillStyle = col
          ctx.font = `${floatLblPx}px sans-serif`
          ctx.textAlign = 'center'
          const lines = pat.text.split('\n')
          lines.forEach((ln, li) => ctx.fillText(ln, X(pCenter), Y(candleHigh + offsetPrice) - li * (floatLblPx + 2)))
          if (P.showInfo) {
            ctx.fillStyle = rgba('#808080', 0.7)
            ctx.font = '10px sans-serif'
            ctx.fillText('ⓘ', X(pCenter), Y(candleHigh + offsetPrice) - lines.length * (floatLblPx + 2) - 2)
          }
        }
      }
    }

    ctx.restore()
    return false
  },
}
