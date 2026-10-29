/**
 * Thin React toolbar over klinecharts 10 core APIs (no @klinecharts/pro).
 * Hand-draw overlays, magnet, clear; timezone; pane max/min; multi Y-axis;
 * programmatic scroll/zoom; theme switch via registerStyles names.
 */
import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { Chart, OverlayMode, PaneState } from 'klinecharts'
import {
  USER_DRAW_GROUP,
  clearUserDrawings,
  createUserDrawing,
  setUserDrawMagnet,
  toggleLeftYAxis,
  zoomByFactor,
} from './kline-v10.js'

export type DrawToolName =
  | 'segment'
  | 'rayLine'
  | 'straightLine'
  | 'horizontalStraightLine'
  | 'verticalStraightLine'
  | 'horizontalRayLine'
  | 'horizontalSegment'
  | 'verticalRayLine'
  | 'verticalSegment'
  | 'priceLine'
  | 'priceChannelLine'
  | 'parallelStraightLine'
  | 'fibonacciLine'
  | 'brush'
  | 'simpleAnnotation'
  | 'simpleTag'

const DRAW_TOOLS: { name: DrawToolName; label: string; title: string }[] = [
  { name: 'segment', label: '线', title: '线段' },
  { name: 'rayLine', label: '射', title: '射线' },
  { name: 'straightLine', label: '直', title: '直线' },
  { name: 'horizontalStraightLine', label: '─', title: '水平直线' },
  { name: 'verticalStraightLine', label: '│', title: '垂直直线' },
  { name: 'priceLine', label: '价', title: '价格线' },
  { name: 'priceChannelLine', label: '通', title: '价格通道' },
  { name: 'parallelStraightLine', label: '平', title: '平行直线' },
  { name: 'fibonacciLine', label: '斐', title: '斐波那契回调' },
  { name: 'brush', label: '刷', title: '笔刷' },
  { name: 'simpleAnnotation', label: '注', title: '简单标注' },
  { name: 'simpleTag', label: '标', title: '简单标签' },
]

const MAGNETS: { mode: OverlayMode; label: string; title: string }[] = [
  { mode: 'normal', label: '无', title: '无磁吸' },
  { mode: 'weak_magnet', label: '弱', title: '弱磁吸' },
  { mode: 'strong_magnet', label: '强', title: '强磁吸' },
]

const TIMEZONES = [
  { id: 'Asia/Tokyo', label: '东京' },
  { id: 'Asia/Shanghai', label: '上海' },
  { id: 'UTC', label: 'UTC' },
  { id: 'America/New_York', label: '纽约' },
]

const btnBase: CSSProperties = {
  width: 28,
  height: 26,
  padding: 0,
  margin: 0,
  border: '1px solid rgba(128,128,128,0.35)',
  borderRadius: 4,
  background: 'rgba(22,27,34,0.92)',
  color: '#c9d1d9',
  fontSize: 11,
  lineHeight: '24px',
  textAlign: 'center',
  cursor: 'pointer',
  userSelect: 'none',
}

function ToolBtn({
  title,
  active,
  onClick,
  children,
  wide,
}: {
  title: string
  active?: boolean
  onClick: () => void
  children: ReactNode
  wide?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active === true}
      onClick={onClick}
      style={{
        ...btnBase,
        width: wide ? 52 : 28,
        background: active ? 'rgba(56,189,248,0.25)' : btnBase.background,
        borderColor: active ? 'rgba(56,189,248,0.7)' : 'rgba(128,128,128,0.35)',
        color: active ? '#7dd3fc' : '#c9d1d9',
      }}
    >
      {children}
    </button>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center' }}>
      <div style={{ fontSize: 9, color: '#8b949e', letterSpacing: 0.5 }}>{label}</div>
      {children}
    </div>
  )
}

export function ChartTools({
  chart,
  dark,
  onThemeChange,
}: {
  chart: Chart | null
  dark: boolean
  /** Optional: parent can sync OS/theme state when user picks a named style. */
  onThemeChange?: (name: 'dsh-dark' | 'dsh-light') => void
}): JSX.Element | null {
  const [magnet, setMagnet] = useState<OverlayMode>('normal')
  const [activeTool, setActiveTool] = useState<DrawToolName | null>(null)
  const [tz, setTz] = useState('Asia/Tokyo')
  const [leftY, setLeftY] = useState(false)
  const [paneState, setPaneState] = useState<PaneState>('normal')
  const [theme, setTheme] = useState<'dsh-dark' | 'dsh-light'>(dark ? 'dsh-dark' : 'dsh-light')
  const [coordHint, setCoordHint] = useState('')

  useEffect(() => {
    setTheme(dark ? 'dsh-dark' : 'dsh-light')
  }, [dark])

  useEffect(() => {
    if (!chart) return
    try { setTz(chart.getTimezone() || 'Asia/Tokyo') } catch { /* */ }
  }, [chart])

  const startDraw = useCallback((name: DrawToolName) => {
    if (!chart) return
    setActiveTool(name)
    createUserDrawing(chart, name, magnet)
  }, [chart, magnet])

  const applyMagnet = useCallback((mode: OverlayMode) => {
    setMagnet(mode)
    if (chart) setUserDrawMagnet(chart, mode)
  }, [chart])

  const clearDraw = useCallback(() => {
    if (!chart) return
    clearUserDrawings(chart)
    setActiveTool(null)
  }, [chart])

  const setTimezone = useCallback((id: string) => {
    if (!chart) return
    chart.setTimezone(id)
    setTz(id)
  }, [chart])

  const cyclePane = useCallback(() => {
    if (!chart) return
    const next: PaneState = paneState === 'normal' ? 'maximize' : paneState === 'maximize' ? 'minimize' : 'normal'
    try {
      chart.setPaneOptions({ id: 'candle_pane', state: next })
      setPaneState(next)
    } catch (e) {
      console.warn('[client-chart] setPaneOptions failed', e)
    }
  }, [chart, paneState])

  const toggleY = useCallback(() => {
    if (!chart) return
    const on = toggleLeftYAxis(chart, !leftY)
    setLeftY(on)
  }, [chart, leftY])

  const applyTheme = useCallback((name: 'dsh-dark' | 'dsh-light') => {
    if (!chart) return
    try {
      chart.setStyles(name)
      setTheme(name)
      onThemeChange?.(name)
    } catch (e) {
      console.warn('[client-chart] setStyles(theme) failed', e)
    }
  }, [chart, onThemeChange])

  const sampleConvert = useCallback(() => {
    if (!chart) return
    const list = chart.getDataList()
    const last = list[list.length - 1]
    if (!last) { setCoordHint('无数据'); return }
    const px = chart.convertToPixel({ timestamp: last.timestamp, value: last.close })
    const p = (Array.isArray(px) ? px[0] : px) as { x?: number; y?: number } | undefined
    const back = chart.convertFromPixel([{ x: p?.x ?? 0, y: p?.y ?? 0 }])
    const b = (Array.isArray(back) ? back[0] : back) as { value?: number } | undefined
    setCoordHint(`px(${Math.round(p?.x ?? 0)},${Math.round(p?.y ?? 0)}) ← ${typeof b?.value === 'number' ? b.value.toFixed(2) : '—'}`)
  }, [chart])

  if (!chart) return null

  const paneLabel = paneState === 'normal' ? '窗' : paneState === 'maximize' ? '大' : '小'

  return (
    <div
      role="toolbar"
      aria-label="图表工具"
      data-testid="chart-tools"
      style={{
        position: 'absolute',
        left: 6,
        top: 6,
        bottom: 28,
        zIndex: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '6px 4px',
        borderRadius: 6,
        background: 'rgba(13,17,23,0.78)',
        border: '1px solid rgba(128,128,128,0.3)',
        backdropFilter: 'blur(4px)',
        overflowY: 'auto',
        maxHeight: '100%',
        pointerEvents: 'auto',
      }}
    >
      <Section label="画线">
        {DRAW_TOOLS.map(t => (
          <ToolBtn key={t.name} title={t.title} active={activeTool === t.name} onClick={() => startDraw(t.name)}>
            {t.label}
          </ToolBtn>
        ))}
        <ToolBtn title="清除手动画线" onClick={clearDraw}>清</ToolBtn>
      </Section>

      <Section label="磁吸">
        {MAGNETS.map(m => (
          <ToolBtn key={m.mode} title={m.title} active={magnet === m.mode} onClick={() => applyMagnet(m.mode)}>
            {m.label}
          </ToolBtn>
        ))}
      </Section>

      <Section label="视窗">
        <ToolBtn title="向左滚动" onClick={() => chart.scrollByDistance(-120, 200)}>←</ToolBtn>
        <ToolBtn title="向右滚动" onClick={() => chart.scrollByDistance(120, 200)}>→</ToolBtn>
        <ToolBtn title="回到最新" onClick={() => chart.scrollToRealTime(200)}>新</ToolBtn>
        <ToolBtn title="放大" onClick={() => zoomByFactor(chart, 1.2)}>＋</ToolBtn>
        <ToolBtn title="缩小" onClick={() => zoomByFactor(chart, 1 / 1.2)}>－</ToolBtn>
        <ToolBtn title="柱宽加大" onClick={() => { try { chart.setBarSpace(chart.getBarSpace().bar + 2) } catch { /* */ } }}>宽</ToolBtn>
        <ToolBtn title="柱宽减小" onClick={() => { try { chart.setBarSpace(Math.max(2, chart.getBarSpace().bar - 2)) } catch { /* */ } }}>窄</ToolBtn>
      </Section>

      <Section label="窗格">
        <ToolBtn title={`主图窗格：${paneState}（点击切换 普通/最大化/最小化）`} active={paneState !== 'normal'} onClick={cyclePane}>
          {paneLabel}
        </ToolBtn>
      </Section>

      <Section label="Y轴">
        <ToolBtn title="切换左侧副Y轴" active={leftY} onClick={toggleY}>双</ToolBtn>
      </Section>

      <Section label="主题">
        <ToolBtn title="深色主题 dsh-dark" active={theme === 'dsh-dark'} onClick={() => applyTheme('dsh-dark')}>暗</ToolBtn>
        <ToolBtn title="浅色主题 dsh-light" active={theme === 'dsh-light'} onClick={() => applyTheme('dsh-light')}>亮</ToolBtn>
      </Section>

      <Section label="时区">
        {TIMEZONES.map(t => (
          <ToolBtn key={t.id} title={`时区 ${t.id}`} active={tz === t.id} wide onClick={() => setTimezone(t.id)}>
            {t.label}
          </ToolBtn>
        ))}
      </Section>

      <Section label="坐标">
        <ToolBtn title="演示 convertToPixel / convertFromPixel" wide onClick={sampleConvert}>换算</ToolBtn>
        {coordHint
          ? <div style={{ maxWidth: 56, fontSize: 9, color: '#8b949e', wordBreak: 'break-all', textAlign: 'center' }}>{coordHint}</div>
          : null}
      </Section>
    </div>
  )
}
