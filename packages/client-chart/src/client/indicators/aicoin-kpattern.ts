/**
 * AiCoin「K线形态」脚本 1:1 移植（用户提供的 // @version=2 源码）。
 *
 * - 15 个 plotText：条件、title、text、color、refSeries、placement 与源码逐条一致（KP_PLOTS 顺序 = 源码 plotText 顺序）。
 * - 15 个 alertcondition：title / direction 与源码一致（KP_ALERTS 顺序 = 源码 alertcondition 顺序）。
 * - 源码里的常数（0.005 振幅、0.000015 平头容差、factor 0.24、0.003 波动、5/10 根回看）是硬编码，不是 input，所以不做成参数。
 * - plotText 未传 bgColor / fontSize：按 AiCoin 文档默认 bgColor=rgba(255,255,255,1)、fontSize=14。
 *   color 'green' / 'red' 为常用颜色名，按 CSS 取 #008000 / #ff0000。关闭「跟随主题配色」即为这套源码配色。
 * - 插件适配（AiCoin 没有的）：跟随图表主题涨跌色、标签碰撞避让（完整→简写→三角）、未收盘 K 线半透明、showLast。
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
/** plotText placement bottom = 看涨（绿色、画在低点下方），top = 看跌。 */
export const kpIsBull = (n: number): boolean => KP_PLOTS[n]!.placement === 'bottom'
export const KP_BULL_INDICES: readonly number[] = KP_PLOTS.map((_, n) => n).filter(kpIsBull)
export const KP_BEAR_INDICES: readonly number[] = KP_PLOTS.map((_, n) => n).filter(n => !kpIsBull(n))

/** 插件「简写」标签：K 线间距不够放完整文字时用。 */
export const KP_SHORT: Record<KpKey, string> = {
  hammer: '锤子', hangingMan: '上吊', shootingStar: '流星', darkCloudCover: '乌云', piercingLine: '刺透',
  dojiTop: '平顶', dojiBottom: '平底', bullishEngulfing: '涨吞', bearishEngulfing: '跌吞', morningStar: '启明',
  eveningStar: '黄昏', redThreeSoldiers: '红三', blackThreeSoldiers: '黑三', topFormation: '顶分', bottomFormation: '底分',
}

/**
 * 参数槽位
 *   1:1 源码段  [0,15) 显示  [15,30) 颜色  30 字号  31 文字背景  32 背景色  [33,48) 提醒（alertcondition 顺序）
 *   插件段      48 跟随主题配色  49 标签模式  50 未收盘K线标注  51 只显示最近N根(=plotText showLast, 0 全部)
 * 插件段追加在末尾，已保存的设置下标不变。
 */
export const KP_SHOW = 0
export const KP_COLOR = KP_N
export const KP_FONT = 2 * KP_N
export const KP_BG_ON = KP_FONT + 1
export const KP_BG_COLOR = KP_FONT + 2
export const KP_ALERT = KP_FONT + 3
export const KP_THEME = KP_ALERT + KP_ALERTS.length
export const KP_MODE = KP_THEME + 1
export const KP_FORMING = KP_THEME + 2
export const KP_LAST = KP_THEME + 3

export const KP_LABEL_MODES = ['自动避让', '完整文字', '简写', '仅标记'] as const

export const KP_DEFAULTS: readonly number[] = [
  ...KP_PLOTS.map(() => 1),
  ...KP_PLOTS.map(p => KP_NAMED_COLOR[p.color]),
  14, 1, 0xffffff,
  ...KP_ALERTS.map(() => 0),
  1, 0, 1, 0,
]

export interface KpParams {
  show: boolean[]
  color: number[]
  fontSize: number
  bgOn: boolean
  bgColor: number
  /** Indexed like KP_ALERTS. */
  alertOn: boolean[]
  /** 用图表主题的涨跌色（有主题信息时）；关闭 = 源码颜色 + 自定义颜色。 */
  theme: boolean
  /** 0 自动避让  1 完整文字  2 简写  3 仅标记 */
  mode: number
  forming: boolean
  showLast: number
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
    theme: num(KP_THEME) === 1,
    mode: Math.max(0, Math.min(KP_LABEL_MODES.length - 1, Math.round(num(KP_MODE)))),
    forming: num(KP_FORMING) === 1,
    showLast: Math.max(0, Math.round(num(KP_LAST))),
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

/** 图表主题（由 ChartCard 经 extendData 传入）：涨/跌色、标签底色，reserve = 预留给 TD 主图计数的像素。 */
export interface KpTheme { up: string; down: string; bg: string; reserve?: number }
export function asKpTheme(ext: unknown): KpTheme | undefined {
  const e = ext as Partial<KpTheme> | null | undefined
  return e && typeof e.up === 'string' && typeof e.down === 'string' && typeof e.bg === 'string' ? e as KpTheme : undefined
}
export const withAlpha = (hex: string, a: number): string => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1]!, 16)
  return 'rgba(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + a + ')'
}

export interface KpLabelStyle { text: string; fill?: string; tint?: string; stroke?: string }
/** 主题模式：主题涨跌色的描边小标签；源码模式：plotText 的 color + bgColor。 */
export function kpStyle(P: KpParams, n: number, theme: KpTheme | undefined): KpLabelStyle {
  if (P.theme && theme) {
    const c = kpIsBull(n) ? theme.up : theme.down
    return { text: c, fill: theme.bg, tint: withAlpha(c, 0.16), stroke: withAlpha(c, 0.6) }
  }
  return P.bgOn ? { text: kpHex(P.color[n]!), fill: kpHex(P.bgColor) } : { text: kpHex(P.color[n]!) }
}

const FONT_FAMILY = 'system-ui, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif'
/** 文字框内边距 / 与 K 线的距离 / 堆叠间距（px）。 */
const PAD = 2
const GAP = 4
const STACK = 2
/** 自动避让：每种文字最多往外挪的层数，放不下就退到简写，再退到小三角。 */
const AUTO_SLOTS = 3
const FORCED_SLOTS = 8
const FORMING_ALPHA = 0.5

export function createKPatternTooltipDataSource({ indicator, crosshair }: {
  indicator: { calcParams: number[]; result: KpRow[]; extendData?: unknown }
  crosshair: { dataIndex?: number | undefined }
}) {
  const P = sanitizeKpParams(indicator.calcParams ?? [])
  const theme = asKpTheme(indicator.extendData)
  const i = crosshair.dataIndex
  const row = i !== undefined ? indicator.result?.[i] : undefined
  const values = KP_PLOTS.flatMap((p, k) => (P.show[k] && row?.[p.key]
    ? [{ title: p.title + ': ', value: { text: p.text, color: kpStyle(P, k, theme).text } }]
    : []))
  return { name: 'K线形态', calcParamsText: '', values, icons: [] }
}

interface DrawArgs {
  ctx: CanvasRenderingContext2D
  indicator: { calcParams: number[]; result: KpRow[]; extendData?: unknown }
  xAxis: { convertToPixel: (val: number) => number }
  yAxis: { convertToPixel: (val: number) => number }
  visibleRange: { from: number; to: number }
  bounding?: { width: number; height: number }
  barSpace?: { bar?: number }
  kLineDataList: { high?: number; low?: number }[]
}

interface Rect { x0: number; x1: number; y0: number; y1: number }

/**
 * plotText 的插件渲染：top 画在 high 上方、bottom 画在 low 下方。
 * 与 AiCoin 不同的是这里做碰撞避让 —— 相邻 K 线的标签不叠在一起：
 * 自动模式依次尝试 完整文字 → 简写 → 小三角；最后一根（未收盘）K 线半透明，可关闭。
 */
export function drawKPatterns({ ctx, indicator, xAxis, yAxis, visibleRange, bounding, barSpace, kLineDataList }: DrawArgs): boolean {
  const rows = indicator.result
  if (!rows || rows.length === 0) return true
  const P = sanitizeKpParams(indicator.calcParams ?? [])
  const theme = asKpTheme(indicator.extendData)
  const reserve = theme?.reserve ?? 0
  const H = bounding?.height ?? Infinity
  const last = rows.length - 1
  const from = Math.max(0, visibleRange.from, P.showLast > 0 ? rows.length - P.showLast : 0)
  const to = Math.min(last, visibleRange.to)
  if (from > to) return true
  const boxH = P.fontSize + 2 * PAD
  const tri = Math.max(3, Math.min(6, (barSpace?.bar ?? 8) / 2))
  ctx.save()
  ctx.font = P.fontSize + 'px ' + FONT_FAMILY
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const widths = new Map<string, number>()
  const width = (s: string): number => {
    let w = widths.get(s)
    if (w === undefined) { w = ctx.measureText(s).width + 2 * PAD; widths.set(s, w) }
    return w
  }
  let placed: Rect[] = []
  const free = (r: Rect): boolean => r.y0 >= 0 && r.y1 <= H && !placed.some(p => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0)
  const label = (t: string, x: number, r: Rect, st: KpLabelStyle): void => {
    const w = r.x1 - r.x0
    if (st.fill) { ctx.fillStyle = st.fill; ctx.fillRect(r.x0, r.y0, w, boxH) }
    if (st.tint) { ctx.fillStyle = st.tint; ctx.fillRect(r.x0, r.y0, w, boxH) }
    if (st.stroke) { ctx.strokeStyle = st.stroke; ctx.lineWidth = 1; ctx.strokeRect(r.x0 + 0.5, r.y0 + 0.5, w - 1, boxH - 1) }
    ctx.fillStyle = st.text
    ctx.fillText(t, x, r.y0 + boxH / 2)
  }
  for (let i = from; i <= to; i++) {
    const row = rows[i]; const k = kLineDataList[i]
    if (!row || !k) continue
    const forming = i === last
    if (forming && !P.forming) continue
    const x = xAxis.convertToPixel(i)
    if (placed.length > 64) placed = placed.filter(p => p.x1 > x - 400)
    ctx.globalAlpha = forming ? FORMING_ALPHA : 1
    const marks = { top: 0, bottom: 0 }
    for (let n = 0; n < KP_N; n++) {
      const p = KP_PLOTS[n]!
      if (!P.show[n] || !row[p.key]) continue
      const top = p.placement === 'top'
      const ref = top ? k.high : k.low
      if (ref === undefined) continue
      const y0 = yAxis.convertToPixel(ref)
      const st = kpStyle(P, n, theme)
      const slotTop = (s: number): number => (top ? y0 - GAP - reserve - boxH - s * (boxH + STACK) : y0 + GAP + reserve + s * (boxH + STACK))
      const texts = P.mode === 1 ? [p.text] : P.mode === 2 ? [KP_SHORT[p.key]] : P.mode === 3 ? [] : [p.text, KP_SHORT[p.key]]
      const slots = P.mode === 0 ? AUTO_SLOTS : FORCED_SLOTS
      let done = false
      for (const t of texts) {
        const w = width(t)
        for (let s = 0; s < slots && !done; s++) {
          const yt = slotTop(s)
          const r = { x0: x - w / 2, x1: x + w / 2, y0: yt, y1: yt + boxH }
          if (free(r)) { placed.push(r); label(t, x, r, st); done = true }
        }
        if (done) break
      }
      if (!done && (P.mode === 1 || P.mode === 2)) {
        // 用户指定了文字模式：放不下也照画，贴边截住不出界。
        const t = texts[0]!; const w = width(t)
        const yt = Math.max(0, Math.min(slotTop(0), H - boxH))
        const r = { x0: x - w / 2, x1: x + w / 2, y0: yt, y1: yt + boxH }
        placed.push(r); label(t, x, r, st); done = true
      }
      if (!done) {
        // 小三角：看涨 ▲ 在低点下方，看跌 ▼ 在高点上方；同一根 K 线多个就往外叠。
        const m = marks[p.placement]++
        const h = tri * 1.6
        const tip = top ? y0 - GAP - reserve - m * (h + 2) : y0 + GAP + reserve + m * (h + 2)
        const base = top ? tip - h : tip + h
        ctx.beginPath(); ctx.moveTo(x, tip); ctx.lineTo(x + tri, base); ctx.lineTo(x - tri, base); ctx.closePath()
        ctx.fillStyle = st.text; ctx.fill()
        placed.push({ x0: x - tri, x1: x + tri, y0: Math.min(tip, base), y1: Math.max(tip, base) })
      }
    }
  }
  ctx.globalAlpha = 1
  ctx.restore()
  return true
}

/** klinecharts 注册（主图叠加；plotText 不画线，无 figures，不影响 Y 轴范围 —— 同 AiCoin excludeRange）。 */
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
