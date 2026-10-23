/**
 * AiCoin「K线形态」脚本 1:1 移植（用户提供的 // @version=2 源码）。
 *
 * - 15 个 plotText：条件、title、text、color、refSeries、placement 与源码逐条一致（KP_PLOTS 顺序 = 源码 plotText 顺序）。
 * - 15 个 alertcondition：title / direction 与源码一致（KP_ALERTS 顺序 = 源码 alertcondition 顺序）。
 * - 源码里的常数（0.005 振幅、0.000015 平头容差、factor 0.24、0.003 波动、5/10 根回看）是硬编码，不是 input，所以不做成参数。
 * - plotText 未传 bgColor / fontSize：按 AiCoin 文档默认 bgColor=rgba(255,255,255,1)、fontSize=14。
 *   color 'green' / 'red' 为常用颜色名，按 CSS 取 #008000 / #ff0000。
 * - highest/lowest 回看窗口不足（K 线历史开头几根）视为 nan，比较结果为 false。
 */
export interface KpCandle { open: number; high: number; low: number; close: number }

export const KP_PLOTS = [
  { key: 'hammer', title: '锤子线', text: '锤子线', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'hangingMan', title: '上吊线', text: '上吊线', color: 'red', ref: 'high', placement: 'top' },
  { key: 'shootingStar', title: '流星线', text: '流星线', color: 'red', ref: 'high', placement: 'top' },
  { key: 'darkCloudCover', title: '乌云盖顶', text: '乌云盖顶', color: 'red', ref: 'high', placement: 'top' },
  { key: 'piercingLine', title: '刺透', text: '刺透', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'dojiTop', title: '平头顶', text: '平头顶', color: 'red', ref: 'high', placement: 'top' },
  { key: 'dojiBottom', title: '平头底', text: '平头底', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'bullishEngulfing', title: '看涨吞没', text: '涨吞没', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'bearishEngulfing', title: '看跌吞没', text: '跌吞没', color: 'red', ref: 'high', placement: 'top' },
  { key: 'morningStar', title: '启明星', text: '启明星', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'eveningStar', title: '黄昏星', text: '黄昏星', color: 'red', ref: 'high', placement: 'top' },
  { key: 'redThreeSoldiers', title: '红三兵', text: '红三兵', color: 'green', ref: 'low', placement: 'bottom' },
  { key: 'blackThreeSoldiers', title: '黑三兵', text: '黑三兵', color: 'red', ref: 'high', placement: 'top' },
  { key: 'topFormation', title: '顶分型', text: '顶分型', color: 'red', ref: 'high', placement: 'top' },
  { key: 'bottomFormation', title: '底分型', text: '底分型', color: 'green', ref: 'low', placement: 'bottom' },
] as const

export type KpKey = typeof KP_PLOTS[number]['key']
export type KpRow = Record<KpKey, boolean>

/** alertcondition(…) 源码顺序。 */
export const KP_ALERTS: readonly { key: KpKey; title: string; direction: 'buy' | 'sell' }[] = [
  { key: 'hammer', title: '锤子线', direction: 'buy' },
  { key: 'hangingMan', title: '上吊线', direction: 'sell' },
  { key: 'shootingStar', title: '流星线', direction: 'sell' },
  { key: 'bullishEngulfing', title: '看涨吞没', direction: 'buy' },
  { key: 'bearishEngulfing', title: '看跌吞没', direction: 'sell' },
  { key: 'darkCloudCover', title: '乌云盖顶', direction: 'sell' },
  { key: 'piercingLine', title: '刺透形态', direction: 'buy' },
  { key: 'morningStar', title: '启明星', direction: 'buy' },
  { key: 'eveningStar', title: '黄昏星', direction: 'sell' },
  { key: 'dojiTop', title: '平头顶', direction: 'sell' },
  { key: 'dojiBottom', title: '平头底', direction: 'buy' },
  { key: 'topFormation', title: '顶分型', direction: 'sell' },
  { key: 'bottomFormation', title: '底分型', direction: 'buy' },
  { key: 'redThreeSoldiers', title: '红三兵', direction: 'buy' },
  { key: 'blackThreeSoldiers', title: '黑三兵', direction: 'sell' },
]

/** CSS 颜色名 → 0xRRGGBB（AiCoin「常用颜色」）。 */
export const KP_NAMED_COLOR = { green: 0x008000, red: 0xff0000 } as const

export const KP_N = KP_PLOTS.length
/** 参数槽位：[0,15) 显示  [15,30) 颜色  30 字号  31 文字背景  32 背景色  [33,48) 提醒（alertcondition 顺序）。 */
export const KP_SHOW = 0
export const KP_COLOR = KP_N
export const KP_FONT = 2 * KP_N
export const KP_BG_ON = KP_FONT + 1
export const KP_BG_COLOR = KP_FONT + 2
export const KP_ALERT = KP_FONT + 3

export const KP_DEFAULTS: readonly number[] = [
  ...KP_PLOTS.map(() => 1),
  ...KP_PLOTS.map(p => KP_NAMED_COLOR[p.color]),
  14, 1, 0xffffff,
  ...KP_ALERTS.map(() => 0),
]

export interface KpParams {
  show: boolean[]
  color: number[]
  fontSize: number
  bgOn: boolean
  bgColor: number
  /** Indexed like KP_ALERTS. */
  alertOn: boolean[]
}

export function sanitizeKpParams(params: readonly unknown[]): KpParams {
  const num = (i: number): number => {
    const v = params[i]
    return typeof v === 'number' && Number.isFinite(v) ? v : KP_DEFAULTS[i]!
  }
  const color = (i: number): number => Math.max(0, Math.min(0xffffff, Math.round(num(i))))
  return {
    show: KP_PLOTS.map((_, k) => num(KP_SHOW + k) === 1),
    color: KP_PLOTS.map((_, k) => color(KP_COLOR + k)),
    fontSize: Math.max(6, Math.min(40, Math.round(num(KP_FONT)))),
    bgOn: num(KP_BG_ON) === 1,
    bgColor: color(KP_BG_COLOR),
    alertOn: KP_ALERTS.map((_, k) => num(KP_ALERT + k) === 1),
  }
}

/** 逐根计算 15 个形态条件；越界的历史值为 nan（比较一律 false）。 */
export function calculateKPatterns(c: readonly KpCandle[]): KpRow[] {
  const O = (i: number): number => (i >= 0 && i < c.length ? c[i]!.open : NaN)
  const H = (i: number): number => (i >= 0 && i < c.length ? c[i]!.high : NaN)
  const L = (i: number): number => (i >= 0 && i < c.length ? c[i]!.low : NaN)
  const C = (i: number): number => (i >= 0 && i < c.length ? c[i]!.close : NaN)
  /** highest(src[off], len) at bar i = max(src[i-off-len+1 .. i-off]); window not available → nan. */
  const highest = (src: (i: number) => number, off: number, len: number, i: number): number => {
    const start = i - off - len + 1
    if (start < 0) return NaN
    let m = -Infinity
    for (let j = start; j <= i - off; j++) m = Math.max(m, src(j))
    return m
  }
  const lowest = (src: (i: number) => number, off: number, len: number, i: number): number => {
    const start = i - off - len + 1
    if (start < 0) return NaN
    let m = Infinity
    for (let j = start; j <= i - off; j++) m = Math.min(m, src(j))
    return m
  }
  const wave = (k: number): number => Math.abs(C(k) - O(k)) / O(k)
  const change = (k: number): number => C(k) - O(k)
  const factor = 0.24

  return c.map((_, i) => {
    const open = O(i); const high = H(i); const low = L(i); const close = C(i)
    const HighestHigh = H(i - 1) > highest(H, 2, 5, i)
    const lowestLow = L(i - 1) < lowest(L, 2, 5, i)
    const ampl = (high - low) / C(i - 1)
    const solid = Math.abs(close - open)
    const overshadow = high - Math.max(open, close)
    const undershadow = Math.min(close, open) - low

    const hammer = undershadow >= 2 * Math.abs(close - open) && ampl > 0.005 && low < lowest(L, 1, 10, i) && overshadow < 0.5 * solid
    const hangingMan = undershadow >= 2 * Math.abs(close - open) && ampl > 0.005 && H(i - 1) > highest(H, 2, 10, i) && overshadow < 0.5 * solid
    const shootingStar = overshadow >= 2 * Math.abs(close - open) && ampl > 0.005 && high > highest(H, 1, 10, i) && undershadow < 0.5 * solid
    const darkCloudCover = O(i - 1) < C(i - 1) && open > close && open > C(i - 1) && close > O(i - 1) && close < (O(i - 1) + C(i - 1)) / 2 && HighestHigh
    const piercingLine = O(i - 1) > C(i - 1) && open < close && open < C(i - 1) && close < O(i - 1) && close > (O(i - 1) + C(i - 1)) / 2 && lowestLow
    const dojiTop = Math.abs(high - H(i - 1)) / H(i - 1) <= 0.000015 && HighestHigh
    const dojiBottom = Math.abs(low - L(i - 1)) / L(i - 1) <= 0.000015 && lowestLow
    const bullishEngulfing = O(i - 1) > C(i - 1) && close > open && close > O(i - 1) && open < C(i - 1) && wave(i) > 0.005 && low < L(i - 1)
    const bearishEngulfing = O(i - 1) < C(i - 1) && close < open && close < O(i - 1) && open > C(i - 1) && wave(i) > 0.005 && high > H(i - 1)

    let morningStar = false
    let eveningStar = false
    if (Math.abs(change(i - 1)) < factor * Math.min(Math.abs(change(i)), Math.abs(change(i - 2)))) {
      if (change(i - 2) < 0 && change(i) > 0) {
        if (close > C(i - 2) && H(i - 1) < Math.min(close, O(i - 2)) && L(i - 1) < Math.min(low, L(i - 2)) && lowestLow) morningStar = true
      } else if (change(i - 2) > 0 && change(i) < 0) {
        if (close < C(i - 2) && H(i - 1) > Math.max(H(i - 2), high) && L(i - 1) > Math.max(close, O(i - 2)) && HighestHigh) eveningStar = true
      }
    }

    const redThreeSoldiers = close > open && C(i - 1) > O(i - 1) && C(i - 2) > O(i - 2) && close > C(i - 1) && C(i - 1) > C(i - 2) && wave(i - 2) > 0.003 && wave(i - 1) > 0.003 && wave(i) > 0.003
    const blackThreeSoldiers = close < open && C(i - 1) < O(i - 1) && C(i - 2) < O(i - 2) && close < C(i - 1) && C(i - 1) < C(i - 2) && wave(i - 2) > 0.003 && wave(i - 1) > 0.003 && wave(i) > 0.003
    const topFormation = H(i - 1) > H(i - 2) && H(i - 1) > high && H(i - 1) > highest(H, 2, 10, i) && close < C(i - 1) && O(i - 1) > O(i - 2) && L(i - 2) < L(i - 1) && L(i - 1) > low
    const bottomFormation = L(i - 1) < L(i - 2) && L(i - 1) < low && L(i - 1) < lowest(L, 2, 10, i) && close > H(i - 1) && H(i - 2) > H(i - 1) && high > H(i - 1)

    return {
      hammer, hangingMan, shootingStar, darkCloudCover, piercingLine, dojiTop, dojiBottom,
      bullishEngulfing, bearishEngulfing, morningStar, eveningStar, redThreeSoldiers, blackThreeSoldiers,
      topFormation, bottomFormation,
    }
  })
}

/** 命中的形态 key，按 plotText 顺序。 */
export const kpHits = (row: KpRow | undefined): KpKey[] => (row ? KP_PLOTS.filter(p => row[p.key]).map(p => p.key) : [])

/** 已开启提醒、在最近一根已收盘 K 线（倒数第二根）上触发的 alertcondition。 */
export function kpAlertEvents(candles: readonly (KpCandle & { time: string })[], params: readonly unknown[]): { id: string; text: string }[] {
  if (candles.length < 2) return []
  const P = sanitizeKpParams(params)
  if (!P.alertOn.some(Boolean)) return []
  const i = candles.length - 2
  const row = calculateKPatterns(candles)[i]
  if (!row) return []
  const t = candles[i]!.time
  return KP_ALERTS.filter((a, k) => P.alertOn[k] && row[a.key])
    .map(a => ({ id: t + '|kp.' + a.key, text: a.title + ' · ' + (a.direction === 'buy' ? '买入' : '卖出') + ' (' + t + ')' }))
}

export const kpHex = (n: number): string => '#' + Math.max(0, Math.min(0xffffff, Math.round(n))).toString(16).padStart(6, '0')

const FONT_FAMILY = 'system-ui, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif'
/** 文字框内边距 / 与 K 线的距离 / 同一根 K 线多个文字之间的间距（px）。 */
const PAD = 2
const GAP = 4
const STACK = 2

export function createKPatternTooltipDataSource({ indicator, crosshair }: {
  indicator: { calcParams: number[]; result: KpRow[] }
  crosshair: { dataIndex?: number | undefined }
}) {
  const P = sanitizeKpParams(indicator.calcParams ?? [])
  const i = crosshair.dataIndex
  const row = i !== undefined ? indicator.result?.[i] : undefined
  const values = KP_PLOTS.flatMap((p, k) => (P.show[k] && row?.[p.key]
    ? [{ title: p.title + ': ', value: { text: p.text, color: kpHex(P.color[k]!) } }]
    : []))
  return { name: 'K线形态', calcParamsText: '', values, icons: [] }
}

interface DrawArgs {
  ctx: CanvasRenderingContext2D
  indicator: { calcParams: number[]; result: KpRow[] }
  xAxis: { convertToPixel: (val: number) => number }
  yAxis: { convertToPixel: (val: number) => number }
  visibleRange: { from: number; to: number }
  kLineDataList: { high?: number; low?: number }[]
}

/** plotText：placement top 画在 refSeries(high) 上方，bottom 画在 refSeries(low) 下方；同一根 K 线多个文字按 plotText 顺序向外堆叠。 */
export function drawKPatterns({ ctx, indicator, xAxis, yAxis, visibleRange, kLineDataList }: DrawArgs): boolean {
  const rows = indicator.result
  if (!rows || rows.length === 0) return true
  const P = sanitizeKpParams(indicator.calcParams ?? [])
  const from = Math.max(0, visibleRange.from)
  const to = Math.min(rows.length - 1, visibleRange.to)
  const boxH = P.fontSize + 2 * PAD
  ctx.save()
  ctx.font = P.fontSize + 'px ' + FONT_FAMILY
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = from; i <= to; i++) {
    const row = rows[i]; const k = kLineDataList[i]
    if (!row || !k) continue
    const x = xAxis.convertToPixel(i)
    let above = 0; let below = 0
    KP_PLOTS.forEach((p, n) => {
      if (!P.show[n] || !row[p.key]) return
      const ref = p.ref === 'high' ? k.high : k.low
      if (ref === undefined) return
      const y0 = yAxis.convertToPixel(ref)
      const top = p.placement === 'top'
        ? y0 - GAP - boxH - above++ * (boxH + STACK)
        : y0 + GAP + below++ * (boxH + STACK)
      const w = ctx.measureText(p.text).width + 2 * PAD
      if (P.bgOn) {
        ctx.fillStyle = kpHex(P.bgColor)
        ctx.fillRect(x - w / 2, top, w, boxH)
      }
      ctx.fillStyle = kpHex(P.color[n]!)
      ctx.fillText(p.text, x, top + boxH / 2)
    })
  }
  ctx.restore()
  return true
}

/** klinecharts 注册（主图叠加，plotText 不画线，故无 figures）。 */
export const kPatternIndicator = {
  name: 'AICOIN_KPATTERN',
  shortName: 'K线形态',
  series: 'price' as const,
  precision: 2,
  calcParams: [...KP_DEFAULTS],
  figures: [] as { key: string; title: string; type: string }[],
  calc: (dataList: readonly KpCandle[]) => calculateKPatterns(dataList),
  createTooltipDataSource: createKPatternTooltipDataSource,
  draw: drawKPatterns,
}
