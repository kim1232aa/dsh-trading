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
 * plot 未传 color / linewidth：按 AiCoin 文档默认 rgba(255,255,255,1)、1；面板可改，display 对应「显示」。
 */
export interface TdRow { oup: number; odn: number; up?: number; dn?: number }

/** [显示UP, UP颜色, UP线宽, 显示Down, Down颜色, Down线宽] */
export const TD_DEFAULTS: readonly number[] = [1, 0xffffff, 1, 1, 0xffffff, 1]

export interface TdParams { showUp: boolean; upColor: number; upWidth: number; showDn: boolean; dnColor: number; dnWidth: number }

export function sanitizeTdParams(params: readonly unknown[]): TdParams {
  const num = (i: number): number => {
    const v = params[i]
    return typeof v === 'number' && Number.isFinite(v) ? v : TD_DEFAULTS[i]!
  }
  const color = (i: number): number => Math.max(0, Math.min(0xffffff, Math.round(num(i))))
  const width = (i: number): number => Math.max(1, Math.min(10, Math.round(num(i))))
  return { showUp: num(0) === 1, upColor: color(1), upWidth: width(2), showDn: num(3) === 1, dnColor: color(4), dnWidth: width(5) }
}

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

const hex = (n: number): string => '#' + Math.max(0, Math.min(0xffffff, Math.round(n))).toString(16).padStart(6, '0')

/** klinecharts 注册（副图）。nan → undefined，line 图在该处断开，同 AiCoin plot(nan)。 */
export const aicoinTdIndicator = {
  name: 'AICOIN_TD',
  shortName: 'TD',
  precision: 0,
  calcParams: [...TD_DEFAULTS],
  figures: [
    { key: 'up', title: 'UP: ', type: 'line', styles: (_d: unknown, ind: { calcParams: number[] }) => { const P = sanitizeTdParams(ind.calcParams ?? []); return { color: hex(P.upColor), size: P.upWidth } } },
    { key: 'dn', title: 'Down: ', type: 'line', styles: (_d: unknown, ind: { calcParams: number[] }) => { const P = sanitizeTdParams(ind.calcParams ?? []); return { color: hex(P.dnColor), size: P.dnWidth } } },
  ],
  calc: (dataList: readonly { close: number }[], ind: { calcParams: number[] }) => {
    const P = sanitizeTdParams(ind.calcParams ?? [])
    return calculateAicoinTd(dataList).map(r => ({ up: P.showUp ? r.up : undefined, dn: P.showDn ? r.dn : undefined }))
  },
}
