/**
 * 量比分档量能 (Volume Tier / Volume Ratio Momentum)
 *
 * 算法与规范 1:1 镜像自 reference repo:
 * - 周期 N 默认 4 (可配 2..250)
 * - 量比 = 本周期成交量 ÷ 前 N 个周期成交量均值 (不含本周期，即 REF(MA(volume, N), 1))
 * - 档位划分与配色：
 *   1. 无前值: 灰色 (#a8adb8 / #6b7280) - 前 N 个周期无足够数据或窗口含 NaN 脏数据；前值均值 <= 0 且当前量 == 0
 *   2. 量比<1: 金黄色 (#d9a01f / #e8c552) - 缩量
 *   3. 量比1-2: 浅红/三文鱼色 (#ee7f72 / #f0958b) - 温和放量 (比值恰好等于 1 进此档)
 *   4. 量比2-3: 鲜红 (#c62828 / #e5484d) - 显著放量 (比值恰好等于 2 进此档)
 *   5. 量比≥3: 高亮近白/黑 (#1c1c1e / #f2f4f8) - 极端放量/爆量 (比值恰好等于 3 进此档；前值均值 <= 0 且当前量 > 0 进此档)
 * - 柱高为本周期成交量，档位严格控制柱身颜色
 */

export type VolumeTier = '无前值' | '量比<1' | '量比1-2' | '量比2-3' | '量比≥3'

export const VOLUME_TIERS: readonly VolumeTier[] = ['无前值', '量比<1', '量比1-2', '量比2-3', '量比≥3']

export const VOLUME_TIER_DEFAULT_PERIOD = 4

export const VOLUME_TIER_THEME_COLORS: Record<VolumeTier, { light: string; dark: string }> = {
  无前值: { light: '#a8adb8', dark: '#6b7280' },
  '量比<1': { light: '#d9a01f', dark: '#e8c552' },
  '量比1-2': { light: '#ee7f72', dark: '#f0958b' },
  '量比2-3': { light: '#c62828', dark: '#e5484d' },
  '量比≥3': { light: '#1c1c1e', dark: '#f2f4f8' },
}

export type VolTierRow = {
  volume?: number | undefined
  tier: VolumeTier
  ratio?: number | undefined
}

/**
 * 简单移动平均（滚动均值，遇到非有限值保留 undefined）。
 */
export function sma(values: readonly number[], period: number): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(values.length).fill(undefined)
  if (!Number.isFinite(period) || period < 1 || values.length < period) return out
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0
    let hasDirty = false
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j]
      if (v === undefined || !Number.isFinite(v)) {
        hasDirty = true
        break
      }
      sum += v
    }
    out[i] = hasDirty ? undefined : sum / period
  }
  return out
}

/**
 * 量比 → 档位：
 * 阈值 1/2/3 分四档（比值恰好等于阈值时落较高一档）；
 * undefined (无前值/不可判) 落中性灰档；
 * Number.POSITIVE_INFINITY (前值无量但本周期有量) 落最高档。
 */
export function volumeTierOf(ratio: number | undefined): VolumeTier {
  if (ratio === undefined) return '无前值'
  if (ratio < 1) return '量比<1'
  if (ratio < 2) return '量比1-2'
  if (ratio < 3) return '量比2-3'
  return '量比≥3'
}

/**
 * 量比序列：本周期成交量 ÷ 前 N 个周期成交量均值（不含本周期，等价 REF(MA(volume, N), 1)）。
 * 长度严格等于 bars.length。
 */
export function volumeRatios(bars: readonly { volume?: number }[], period: number): Array<number | undefined> {
  const volumes = bars.map(bar => bar.volume ?? NaN)
  const priorMeans = sma(volumes, period)
  return bars.map((_bar, index) => {
    const volume = volumes[index]
    if (volume === undefined || !Number.isFinite(volume)) return undefined
    const mean = index >= 1 ? priorMeans[index - 1] : undefined
    if (mean === undefined || !Number.isFinite(mean)) return undefined
    if (mean <= 0) return volume > 0 ? Number.POSITIVE_INFINITY : undefined
    return volume / mean
  })
}

/**
 * 计算 K 线序列在指定周期下的量比分档行数据。
 */
export function calcVolTierRows(
  bars: readonly { volume?: number }[],
  period: number = VOLUME_TIER_DEFAULT_PERIOD
): VolTierRow[] {
  const ratios = volumeRatios(bars, period)
  return bars.map((bar, index) => {
    const vol = bar.volume
    const isFinite = typeof vol === 'number' && Number.isFinite(vol)
    const ratio = ratios[index]
    const tier = volumeTierOf(ratio)
    return {
      volume: isFinite ? vol : undefined,
      tier,
      ratio: ratio !== undefined && Number.isFinite(ratio) ? ratio : undefined,
    }
  })
}

export function formatVolume(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '–'
  if (v === 0) return '0.00'
  const abs = Math.abs(v)
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${(v / 1e4).toFixed(2)}万`
  return v.toFixed(2)
}

const GEAR_ICON = {
  id: 'params',
  position: 'right',
  icon: '⚙',
  size: 12,
  fontFamily: 'Segoe UI Symbol, Apple Symbols, sans-serif',
  color: '#8b949e',
  activeColor: '#c9d1d9',
  backgroundColor: 'transparent',
  activeBackgroundColor: 'rgba(139,148,158,0.2)',
  marginLeft: 4,
  marginTop: 4,
  marginRight: 4,
  marginBottom: 4,
  paddingLeft: 2,
  paddingTop: 0,
  paddingRight: 2,
  paddingBottom: 0,
}

export const volTierIndicator = {
  name: 'VOL_TIER',
  shortName: '量比分档量能',
  series: 'volume',
  precision: 2,
  shouldFormatBigNumber: true,
  minValue: 0,
  calcParams: [VOLUME_TIER_DEFAULT_PERIOD],
  figures: [
    {
      key: 'volume',
      title: '量能: ',
      type: 'bar',
      baseValue: 0,
      styles: (
        data: { current?: { indicatorData?: VolTierRow } },
        indicator?: { extendData?: { dark?: boolean } }
      ) => {
        const tier = data.current?.indicatorData?.tier ?? '无前值'
        const isDark = indicator?.extendData?.dark
          ?? (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches)
        const color = VOLUME_TIER_THEME_COLORS[tier]?.[isDark ? 'dark' : 'light'] ?? '#6b7280'
        return { color, borderColor: color }
      },
    },
  ],
  calc: (dataList: { volume?: number }[], indicator: { calcParams?: number[] }) => {
    const period = Math.round(indicator?.calcParams?.[0] ?? VOLUME_TIER_DEFAULT_PERIOD)
    return calcVolTierRows(dataList, period)
  },
  createTooltipDataSource: ({ indicator, crosshair }: {
    indicator: { calcParams?: number[]; extendData?: { dark?: boolean }; result?: VolTierRow[] }
    crosshair: { dataIndex?: number }
  }) => {
    const res = indicator.result ?? []
    if (res.length === 0) return { name: '量比分档量能', calcParamsText: '', values: [], icons: [GEAR_ICON] }
    const i = Math.min(crosshair.dataIndex ?? (res.length - 1), res.length - 1)
    const row = res[i]
    const isDark = indicator.extendData?.dark
      ?? (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches)
    const tier = row?.tier ?? '无前值'
    const color = VOLUME_TIER_THEME_COLORS[tier]?.[isDark ? 'dark' : 'light'] ?? '#6b7280'
    const vol = row?.volume
    const volText = vol !== undefined && Number.isFinite(vol) ? formatVolume(vol) : '–'
    return {
      name: '量比分档量能',
      calcParamsText: '',
      values: [
        {
          title: `${tier}: `,
          value: { text: volText, color },
        },
      ],
      icons: [GEAR_ICON],
    }
  },
}
