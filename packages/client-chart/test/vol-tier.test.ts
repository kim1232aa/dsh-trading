import { describe, expect, it } from 'vitest'
import {
  VOLUME_TIER_DEFAULT_PERIOD,
  VOLUME_TIERS,
  VOLUME_TIER_THEME_COLORS,
  calcVolTierRows,
  formatVolume,
  sma,
  volTierIndicator,
  volumeRatios,
  volumeTierOf,
} from '../src/client/indicators/vol-tier.js'

describe('vol-tier indicator (量比分档量能)', () => {
  it('默认周期为 4，五条档位排序及中英文标识一致', () => {
    expect(VOLUME_TIER_DEFAULT_PERIOD).toBe(4)
    expect(VOLUME_TIERS).toEqual(['无前值', '量比<1', '量比1-2', '量比2-3', '量比≥3'])
    expect(volTierIndicator.name).toBe('VOL_TIER')
    expect(volTierIndicator.shortName).toBe('量比分档量能')
    expect(volTierIndicator.calcParams).toEqual([4])
  })

  it('五条档位均带亮暗双色主题色配置', () => {
    for (const tier of VOLUME_TIERS) {
      const colors = VOLUME_TIER_THEME_COLORS[tier]
      expect(colors).toBeDefined()
      expect(typeof colors.light).toBe('string')
      expect(typeof colors.dark).toBe('string')
    }
    expect(VOLUME_TIER_THEME_COLORS['无前值'].dark).toBe('#6b7280')
    expect(VOLUME_TIER_THEME_COLORS['量比<1'].dark).toBe('#e8c552')
    expect(VOLUME_TIER_THEME_COLORS['量比1-2'].dark).toBe('#f0958b')
    expect(VOLUME_TIER_THEME_COLORS['量比2-3'].dark).toBe('#e5484d')
    expect(VOLUME_TIER_THEME_COLORS['量比≥3'].dark).toBe('#f2f4f8')
  })

  it('量比恰好等于 1 / 2 / 3 时分别落在较高一档', () => {
    expect(volumeTierOf(1)).toBe('量比1-2')
    expect(volumeTierOf(2)).toBe('量比2-3')
    expect(volumeTierOf(3)).toBe('量比≥3')
  })

  it('量比在阈值两侧时按阈值严格切分', () => {
    expect(volumeTierOf(0.999)).toBe('量比<1')
    expect(volumeTierOf(0)).toBe('量比<1')
    expect(volumeTierOf(1.001)).toBe('量比1-2')
    expect(volumeTierOf(1.999)).toBe('量比1-2')
    expect(volumeTierOf(2.001)).toBe('量比2-3')
    expect(volumeTierOf(2.999)).toBe('量比2-3')
    expect(volumeTierOf(3.001)).toBe('量比≥3')
    expect(volumeTierOf(10)).toBe('量比≥3')
    expect(volumeTierOf(Number.POSITIVE_INFINITY)).toBe('量比≥3')
    expect(volumeTierOf(undefined)).toBe('无前值')
  })

  it('前 N 根无前值，落无前值灰档且柱高为各自成交量', () => {
    const bars = [{ volume: 10 }, { volume: 20 }, { volume: 30 }, { volume: 40 }]
    const rows = calcVolTierRows(bars, 4)
    expect(rows).toHaveLength(4)
    for (let i = 0; i < 4; i++) {
      expect(rows[i].tier).toBe('无前值')
      expect(rows[i].volume).toBe(bars[i].volume)
      expect(rows[i].ratio).toBeUndefined()
    }
  })

  it('第 N+1 根基于前 N 根均值准确计算量比', () => {
    // 前4根均值 = (10+10+10+10)/4 = 10
    const bars = [
      { volume: 10 },
      { volume: 10 },
      { volume: 10 },
      { volume: 10 },
      { volume: 15 }, // 15/10 = 1.5 -> 量比1-2
      { volume: 25 }, // 前4根(10,10,10,15)均值 11.25, 25/11.25 = 2.22 -> 量比2-3
    ]
    const rows = calcVolTierRows(bars, 4)
    expect(rows[4].tier).toBe('量比1-2')
    expect(rows[4].ratio).toBeCloseTo(1.5, 4)
    expect(rows[4].volume).toBe(15)

    expect(rows[5].tier).toBe('量比2-3')
    expect(rows[5].ratio).toBeCloseTo(2.222, 2)
    expect(rows[5].volume).toBe(25)
  })

  it('前 N 根均无量且本周期也无量时落无前值灰档', () => {
    const bars = [{ volume: 0 }, { volume: 0 }, { volume: 0 }, { volume: 0 }, { volume: 0 }]
    const rows = calcVolTierRows(bars, 4)
    expect(rows[4].tier).toBe('无前值')
    expect(rows[4].volume).toBe(0)
    expect(rows[4].ratio).toBeUndefined()
  })

  it('前 N 根均无量但本周期有量时发散进入最高档 量比≥3', () => {
    const bars = [{ volume: 0 }, { volume: 0 }, { volume: 0 }, { volume: 0 }, { volume: 100 }]
    const rows = calcVolTierRows(bars, 4)
    expect(rows[4].tier).toBe('量比≥3')
    expect(rows[4].volume).toBe(100)
    expect(rows[4].ratio).toBeUndefined() // infinity mapped to undefined ratio but tier is 量比≥3
  })

  it('脏数据 NaN 不出柱，其后的前值窗口被污染也走灰档', () => {
    const bars = [
      { volume: 10 },
      { volume: 10 },
      { volume: 10 },
      { volume: 10 },
      { volume: NaN },
      { volume: 10 },
    ]
    const rows = calcVolTierRows(bars, 4)
    expect(rows[4].volume).toBeUndefined()
    expect(rows[4].tier).toBe('无前值')

    // 下标 5 的前4根含 NaN -> 均值不可判，走灰档
    expect(rows[5].volume).toBe(10)
    expect(rows[5].tier).toBe('无前值')
  })

  it('自定义周期参数有效（例如 n = 2）', () => {
    const bars = [{ volume: 10 }, { volume: 10 }, { volume: 10 }, { volume: 30 }]
    const rows = calcVolTierRows(bars, 2)
    expect(rows[0].tier).toBe('无前值')
    expect(rows[1].tier).toBe('无前值')
    // 下标 2 的前2根均值 10 -> 10/10 = 1 -> 量比1-2
    expect(rows[2].tier).toBe('量比1-2')
    // 下标 3 的前2根均值 10 -> 30/10 = 3 -> 量比≥3
    expect(rows[3].tier).toBe('量比≥3')
    expect(rows[3].volume).toBe(30)
  })

  it('空序列返回空数组', () => {
    expect(calcVolTierRows([], 4)).toEqual([])
  })

  it('formatVolume 准确格式化数值', () => {
    expect(formatVolume(13.2081)).toBe('13.21')
    expect(formatVolume(0)).toBe('0.00')
    expect(formatVolume(undefined)).toBe('–')
    expect(formatVolume(null)).toBe('–')
    expect(formatVolume(12345.67)).toBe('1.23万')
    expect(formatVolume(150000000)).toBe('1.50亿')
  })

  it('volTierIndicator styles 回调按档位和亮暗主题返回颜色', () => {
    const figure = volTierIndicator.figures[0]
    expect(figure.key).toBe('volume')
    expect(figure.type).toBe('bar')

    const cbDataDark = { current: { indicatorData: { tier: '量比<1' as const, volume: 13.21 } } }
    const resDark = figure.styles(cbDataDark as any, { extendData: { dark: true } } as any)
    expect(resDark.color).toBe('#e8c552')

    const cbDataLight = { current: { indicatorData: { tier: '量比<1' as const, volume: 13.21 } } }
    const resLight = figure.styles(cbDataLight as any, { extendData: { dark: false } } as any)
    expect(resLight.color).toBe('#d9a01f')
  })

  it('volTierIndicator createTooltipDataSource 生成与截图一致的标签和数值', () => {
    const rows = [
      { volume: 10, tier: '无前值' as const },
      { volume: 13.21, tier: '量比<1' as const },
    ]
    const tooltip = volTierIndicator.createTooltipDataSource({
      indicator: { calcParams: [4], extendData: { dark: true }, result: rows },
      crosshair: { dataIndex: 1 },
    })
    expect(tooltip.name).toBe('量比分档量能')
    expect(tooltip.calcParamsText).toBe('')
    expect(tooltip.legends).toHaveLength(1)
    expect(tooltip.legends[0].title).toBe('量比<1: ')
    expect(tooltip.legends[0].value.text).toBe('13.21')
    expect(tooltip.legends[0].value.color).toBe('#e8c552')
    expect(tooltip.features[0].type).toBe('icon_font')
    expect((tooltip.features[0].content as { code: string }).code).toBe('⚙')
  })
})
