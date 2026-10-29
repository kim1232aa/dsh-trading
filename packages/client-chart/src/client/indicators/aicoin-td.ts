/**
 * AiCoin「TD」脚本 1:1 移植（用户提供的 // @version=2 源码，AiCoin研究院）：
 *
 *   oup = close > close[4] ? nz(oup[1]) + 1 : 0
 *   odn = close < close[4] ? nz(odn[1]) - 1 : 0
 *   up = oup > 0 ? oup : nan
 *   dn = odn < 0 ? -odn : nan
 *   plot(up, title = "UP")
 *   plot(dn, title = "Down")
 *
 * 前 4 根 close[4] 为 nan → 条件 false → 0。计数不在 9 截断（源码没有截断）。
 *
 * 计算 1:1；显示走插件路径（AiCoin 只能 plot 两条线，插件可以直接在 K 线上标数字）：
 * - 显示方式：主图数字（默认，UP 计数标在高点上方、Down 计数标在低点下方）/ 副图曲线（= 源码 plot）/ 两者。
 * - 跟随图表主题涨跌色；关闭则用面板颜色（默认 AiCoin plot 默认色 rgba(255,255,255,1)）。
 * - 数字起始：从第 N 根开始标；K 线太密放不下数字时只标 9 和 13；突出 9 / 13。
 * - 计数到 9 / 13 的提醒（源码没有 alertcondition，属插件附加，默认关闭）。
 */
export interface TdRow { oup: number; odn: number; up?: number; dn?: number }

/** 参数槽位：0 显示UP 1 UP色(回落点/卖出结构) 2 UP线宽 3 显示Down 4 Down色(反弹点/买入结构) 5 Down线宽 | 6 显示方式 7 仅显示9和13 8 数字起始 9 突出9/13 10 提醒9 11 提醒13 */
export const TD_MODES = ['主图数字', '副图曲线', '两者'] as const
export const TD_DEFAULTS: readonly number[] = [1, 0x26a380, 1, 1, 0xcf3e3e, 1, 0, 0, 1, 1, 0, 0]

export interface TdParams {
  showUp: boolean; upColor: number; upWidth: number
  showDn: boolean; dnColor: number; dnWidth: number
  mode: number; only9And13: boolean; theme: boolean; start: number; highlight: boolean; alert9: boolean; alert13: boolean
}

export function migrateTdParams(raw: readonly unknown[]): unknown[] {
  const out = [...raw]
  if (out[1] === 0xffffff && out[4] === 0xffffff) {
    out[1] = 0x26a380
    out[4] = 0xcf3e3e
    out[7] = 0
  }
  return out
}

export function sanitizeTdParams(params: readonly unknown[]): TdParams {
  const num = (i: number): number => {
    const v = params[i]
    return typeof v === 'number' && Number.isFinite(v) ? v : TD_DEFAULTS[i]!
  }
  const color = (i: number): number => Math.max(0, Math.min(0xffffff, Math.round(num(i))))
  const width = (i: number): number => Math.max(1, Math.min(10, Math.round(num(i))))
  return {
    showUp: num(0) === 1, upColor: color(1), upWidth: width(2),
    showDn: num(3) === 1, dnColor: color(4), dnWidth: width(5),
    mode: Math.max(0, Math.min(TD_MODES.length - 1, Math.round(num(6)))),
    only9And13: num(7) === 1,
    theme: false,
    start: Math.max(1, Math.min(99, Math.round(num(8)))),
    highlight: num(9) === 1,
    alert9: num(10) === 1,
    alert13: num(11) === 1,
  }
}

/** 主图数字 / 副图曲线 是否需要挂载（ChartCard 据此创建或移除）。 */
export const tdWantsPane = (params: readonly unknown[]): boolean => sanitizeTdParams(params).mode !== 0
export const tdWantsMarks = (params: readonly unknown[]): boolean => sanitizeTdParams(params).mode !== 1

export function calculateAicoinTd(candles: readonly { close: number }[]): TdRow[] {
  const rows: TdRow[] = []
  for (let i = 0; i < candles.length; i++) {
    const close = candles[i]!.close
    const c4 = i >= 4 ? candles[i - 4]!.close : NaN
    const prev = rows[i - 1]
    const oup = close > c4 ? (prev?.oup ?? 0) + 1 : 0
    const odn = close < c4 ? (prev?.odn ?? 0) - 1 : 0
    const row: TdRow = { oup, odn }
    if (oup > 0) row.up = oup
    if (odn < 0) row.dn = -odn
    rows.push(row)
  }
  return rows
}

/** 已开启的 9 / 13 提醒，在最近一根已收盘 K 线（倒数第二根）上。 */
export function tdAlertEvents(candles: readonly { time: string; close: number }[], params: readonly unknown[]): { id: string; text: string }[] {
  if (candles.length < 2) return []
  const P = sanitizeTdParams(params)
  if (!P.alert9 && !P.alert13) return []
  const i = candles.length - 2
  const r = calculateAicoinTd(candles)[i]!
  const t = candles[i]!.time
  const out: { id: string; text: string }[] = []
  for (const [n, on] of [[9, P.alert9], [13, P.alert13]] as const) {
    if (!on) continue
    if (P.showUp && r.up === n) out.push({ id: t + '|td.up' + n, text: 'TD 上涨计数到 ' + n + '（连续收盘高于 4 根前）(' + t + ')' })
    if (P.showDn && r.dn === n) out.push({ id: t + '|td.dn' + n, text: 'TD 下跌计数到 ' + n + '（连续收盘低于 4 根前）(' + t + ')' })
  }
  return out
}

const hex = (n: number): string => '#' + Math.max(0, Math.min(0xffffff, Math.round(n))).toString(16).padStart(6, '0')

/** 图表主题（ChartCard 经 extendData 传入）。 */
export interface TdTheme { up: string; down: string }
const asTheme = (ext: unknown): TdTheme | undefined => {
  const e = ext as Partial<TdTheme> | null | undefined
  return e && typeof e.up === 'string' && typeof e.down === 'string' ? e as TdTheme : undefined
}
export function tdColors(P: TdParams, _ext?: unknown): { up: string; dn: string } {
  void asTheme
  return { up: hex(P.upColor), dn: hex(P.dnColor) }
}

/** 主图数字占用的高度（K 线形态标签据此往外让）。 */
export const TD_MARK_FONT = 10
export const TD_MARK_RESERVE = 18

/** klinecharts 注册（副图 = 源码 plot）。nan → undefined，line 图在该处断开，同 AiCoin plot(nan)。 */
export const aicoinTdIndicator = {
  name: 'AICOIN_TD',
  shortName: 'TD',
  precision: 0,
  calcParams: [...TD_DEFAULTS],
  figures: [
    { key: 'up', title: 'UP: ', type: 'line', styles: (_d: unknown, ind: { calcParams: number[]; extendData?: unknown }) => { const P = sanitizeTdParams(ind.calcParams ?? []); return { color: tdColors(P, ind.extendData).up, size: P.upWidth } } },
    { key: 'dn', title: 'Down: ', type: 'line', styles: (_d: unknown, ind: { calcParams: number[]; extendData?: unknown }) => { const P = sanitizeTdParams(ind.calcParams ?? []); return { color: tdColors(P, ind.extendData).dn, size: P.dnWidth } } },
  ],
  calc: (dataList: readonly { close: number }[], ind: { calcParams: number[] }) => {
    const P = sanitizeTdParams(ind.calcParams ?? [])
    return calculateAicoinTd(dataList).map(r => ({ up: P.showUp ? r.up : undefined, dn: P.showDn ? r.dn : undefined }))
  },
}

interface MarkDrawArgs {
  ctx: CanvasRenderingContext2D
  indicator: { calcParams: number[]; result: TdRow[]; extendData?: unknown }
  xAxis: { convertToPixel: (val: number) => number }
  yAxis: { convertToPixel: (val: number) => number }
  visibleRange: { from: number; to: number }
  barSpace?: { bar?: number }
  kLineDataList: { high?: number; low?: number }[]
}

const FONT_FAMILY = 'system-ui, "Segoe UI", "Microsoft YaHei UI", sans-serif'

/** 主图数字：UP 标在高点上方，Down 标在低点下方；9 / 13 加粗放大；未收盘 K 线半透明。 */
export function drawTdMarks({ ctx, indicator, xAxis, yAxis, visibleRange, barSpace, kLineDataList }: MarkDrawArgs): boolean {
  const rows = indicator.result
  if (!rows || rows.length === 0) return true
  const P = sanitizeTdParams(indicator.calcParams ?? [])
  const col = tdColors(P, indicator.extendData)
  const last = rows.length - 1
  const from = Math.max(0, visibleRange.from)
  const to = Math.min(last, visibleRange.to)
  // 两位数约 12px 宽：K 线更密时只标 9 / 13，避免数字糊成一片。
  const dense = (barSpace?.bar ?? 10) < 7
  ctx.save()
  ctx.textAlign = 'center'
  for (let i = from; i <= to; i++) {
    const r = rows[i]; const k = kLineDataList[i]
    if (!r || !k) continue
    ctx.globalAlpha = i === last ? 0.5 : 1
    const x = xAxis.convertToPixel(i)
    const mark = (n: number | undefined, y: number | undefined, color: string, above: boolean): void => {
      if (n === undefined || y === undefined) return
      const key = n === 9 || n === 13
      const shown = P.only9And13 ? key : (n >= P.start && n <= 9) || n === 13
      if (!shown || (dense && !key)) return
      const big = P.highlight && key
      ctx.font = (big ? 'bold ' : '') + (big ? TD_MARK_FONT + 2 : TD_MARK_FONT) + 'px ' + FONT_FAMILY
      ctx.textBaseline = above ? 'bottom' : 'top'
      ctx.fillStyle = color
      ctx.fillText(String(n), x, above ? yAxis.convertToPixel(y) - 2 : yAxis.convertToPixel(y) + 2)
    }
    if (P.showUp) mark(r.up, k.high, col.up, true)
    if (P.showDn) mark(r.dn, k.low, col.dn, false)
  }
  ctx.globalAlpha = 1
  ctx.restore()
  return true
}

/** klinecharts 注册（主图数字；共用 AICOIN_TD 的参数）。 */
export const aicoinTdMarksIndicator = {
  name: 'AICOIN_TD_MARKS',
  shortName: 'TD',
  series: 'price' as const,
  precision: 0,
  calcParams: [...TD_DEFAULTS],
  figures: [] as { key: string; title: string; type: string }[],
  calc: (dataList: readonly { close: number }[]) => calculateAicoinTd(dataList),
  createTooltipDataSource: ({ indicator, crosshair }: { indicator: { calcParams: number[]; result: TdRow[]; extendData?: unknown }; crosshair: { dataIndex?: number | undefined } }) => {
    const P = sanitizeTdParams(indicator.calcParams ?? [])
    const col = tdColors(P, indicator.extendData)
    const r = crosshair.dataIndex !== undefined ? indicator.result?.[crosshair.dataIndex] : undefined
    const legends: { title: string; value: { text: string; color: string } }[] = []
    if (P.showUp && r?.up !== undefined) legends.push({ title: 'Up:', value: { text: String(r.up), color: col.up } })
    if (P.showDn && r?.dn !== undefined) legends.push({ title: 'Down:', value: { text: String(r.dn), color: col.dn } })
    return { name: 'TD', calcParamsText: '', legends, features: [] }
  },
  draw: drawTdMarks,
}
