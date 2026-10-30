/**
 * Pro PeriodBar–style chart chrome: 指标 / 时区 / 设置 / 截屏 / 全屏 + ☰画线栏折叠.
 * Lives on ChartBody header — not the left DrawingBar.
 * Display prefs (timezone, candle type, grid) persist and re-apply on chart init.
 *
 * Legend-side eye/settings/remove (Pro MA tooltip icons): not wired on every
 * indicator — would need per-indicator TooltipFeatureStyle + click routing.
 * Best-effort substitute: 指标 quick toggles + 详细参数 here.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactElement, ReactNode, RefObject } from 'react'
import type { CandleType, Chart } from 'klinecharts'

export type ChromeIndicator = { name: string; title: string; visible: boolean; group: 'main' | 'sub' }
export type ChromeChip = { id: string; title: string; on: boolean }

export type DisplaySettings = {
  timezone: string
  candleType: CandleType
  gridShow: boolean
  lastPriceShow: boolean
  highPriceShow: boolean
  lowPriceShow: boolean
}

export const DEFAULT_DISPLAY: DisplaySettings = {
  timezone: 'Asia/Tokyo',
  candleType: 'candle_solid',
  gridShow: true,
  lastPriceShow: true,
  highPriceShow: true,
  lowPriceShow: true,
}

const DISPLAY_KEY = 'dsh-trading.chart-display.v1'
let displayCache: DisplaySettings | undefined
const displayListeners = new Set<() => void>()

const CANDLE_TYPES: { key: CandleType; text: string }[] = [
  { key: 'candle_solid', text: '实心蜡烛' },
  { key: 'candle_stroke', text: '空心蜡烛' },
  { key: 'candle_up_stroke', text: '阳线空心' },
  { key: 'candle_down_stroke', text: '阴线空心' },
  { key: 'ohlc', text: 'OHLC' },
  { key: 'area', text: '面积图' },
]

const TIMEZONES: { key: string; text: string }[] = [
  { key: 'Etc/UTC', text: 'UTC' },
  { key: 'America/New_York', text: '纽约' },
  { key: 'America/Chicago', text: '芝加哥' },
  { key: 'America/Los_Angeles', text: '洛杉矶' },
  { key: 'Europe/London', text: '伦敦' },
  { key: 'Europe/Berlin', text: '柏林' },
  { key: 'Asia/Dubai', text: '迪拜' },
  { key: 'Asia/Bangkok', text: '曼谷' },
  { key: 'Asia/Shanghai', text: '上海' },
  { key: 'Asia/Hong_Kong', text: '香港' },
  { key: 'Asia/Tokyo', text: '东京' },
  { key: 'Australia/Sydney', text: '悉尼' },
]

export function sanitizeDisplaySettings(raw: unknown): DisplaySettings {
  const src = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const candleType = CANDLE_TYPES.some(c => c.key === src['candleType'])
    ? src['candleType'] as CandleType
    : DEFAULT_DISPLAY.candleType
  const timezone = typeof src['timezone'] === 'string' && src['timezone'] !== ''
    ? src['timezone']
    : DEFAULT_DISPLAY.timezone
  return {
    timezone,
    candleType,
    gridShow: typeof src['gridShow'] === 'boolean' ? src['gridShow'] : true,
    lastPriceShow: typeof src['lastPriceShow'] === 'boolean' ? src['lastPriceShow'] : true,
    highPriceShow: typeof src['highPriceShow'] === 'boolean' ? src['highPriceShow'] : true,
    lowPriceShow: typeof src['lowPriceShow'] === 'boolean' ? src['lowPriceShow'] : true,
  }
}

export function getDisplaySettings(): DisplaySettings {
  if (displayCache === undefined) {
    let raw: unknown = null
    try { raw = JSON.parse(localStorage.getItem(DISPLAY_KEY) ?? 'null') } catch { /* ignore */ }
    displayCache = sanitizeDisplaySettings(raw)
  }
  return displayCache
}

export function setDisplaySettings(next: DisplaySettings): void {
  displayCache = sanitizeDisplaySettings(next)
  try { localStorage.setItem(DISPLAY_KEY, JSON.stringify(displayCache)) } catch { /* session only */ }
  for (const l of displayListeners) l()
}

export function subscribeDisplaySettings(l: () => void): () => void {
  displayListeners.add(l)
  return () => { displayListeners.delete(l) }
}

/** Partial styles matching Pro SettingModal keys we support. */
export function displayStylesPatch(d: DisplaySettings): Record<string, unknown> {
  return {
    grid: { show: d.gridShow },
    candle: {
      type: d.candleType,
      priceMark: {
        high: { show: d.highPriceShow },
        low: { show: d.lowPriceShow },
        last: { show: d.lastPriceShow },
      },
    },
  }
}

/** Apply timezone + display styles onto a live chart (init + preference changes). */
export function applyDisplayToChart(chart: Chart | null, d: DisplaySettings = getDisplaySettings()): void {
  if (!chart) return
  try {
    if (chart.getTimezone() !== d.timezone) chart.setTimezone(d.timezone)
  } catch { /* ignore */ }
  // Deep-merge patch only — never replace full candle/grid trees (would drop bar colors).
  try { chart.setStyles(displayStylesPatch(d) as never) } catch { /* ignore */ }
}

type PopoverId = 'indicator' | 'timezone' | 'setting' | null

const BTN = (on: boolean, palette: { text: string; line: string }): CSSProperties => ({
  border: `1px solid ${on ? palette.text : palette.line}`,
  background: 'transparent',
  color: 'inherit',
  borderRadius: 4,
  padding: '1px 8px',
  fontSize: 11,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  whiteSpace: 'nowrap',
})

const PANEL = (dark: boolean, palette: { line: string }): CSSProperties => ({
  position: 'absolute',
  top: 'calc(100% + 4px)',
  right: 0,
  zIndex: 10060,
  minWidth: 220,
  maxWidth: 320,
  maxHeight: 360,
  overflowY: 'auto',
  padding: '8px 0',
  background: dark ? '#1c1c1f' : '#ffffff',
  color: dark ? '#c9d1d9' : '#333c45',
  border: `1px solid ${palette.line}`,
  borderRadius: 6,
  boxShadow: '0 8px 24px rgba(0,0,0,.35)',
  fontSize: 12,
})

function useOutsideClose(open: PopoverId, onClose: () => void): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null!)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, onClose])
  return ref
}

function SectionTitle({ children }: { children: ReactNode }): ReactElement {
  return (
    <div style={{ padding: '4px 12px', fontSize: 11, fontWeight: 600, opacity: 0.7 }}>
      {children}
    </div>
  )
}

function CheckRow({
  checked, label, onToggle,
}: { checked: boolean; label: string; onToggle: () => void }): ReactElement {
  return (
    <label
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '5px 12px', cursor: 'pointer', userSelect: 'none',
      }}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span>{label}</span>
    </label>
  )
}

export function ChartChrome({
  chart,
  dark,
  palette,
  fullscreenRef,
  indicators,
  chips,
  onToggleIndicator,
  onToggleChip,
  onOpenParams,
  drawBarOpen,
  onToggleDrawBar,
}: {
  chart: Chart | null
  dark: boolean
  palette: { text: string; faint: string; line: string }
  fullscreenRef: RefObject<HTMLElement | null>
  indicators: ChromeIndicator[]
  chips: ChromeChip[]
  onToggleIndicator: (name: string) => void
  onToggleChip: (id: string) => void
  onOpenParams: () => void
  drawBarOpen: boolean
  onToggleDrawBar: () => void
}): ReactElement {
  const [open, setOpen] = useState<PopoverId>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const display = useSyncExternalStore(subscribeDisplaySettings, getDisplaySettings, () => DEFAULT_DISPLAY)
  const close = useCallback(() => setOpen(null), [])
  const wrapRef = useOutsideClose(open, close)

  useEffect(() => {
    const onFs = (): void => {
      setFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  // Keep chart in sync when prefs change (also applied on init in Kline).
  useEffect(() => {
    applyDisplayToChart(chart, display)
  }, [chart, display])

  const patchDisplay = (partial: Partial<DisplaySettings>): void => {
    setDisplaySettings({ ...getDisplaySettings(), ...partial })
  }

  const screenshot = (): void => {
    if (!chart) return
    try {
      const bg = dark ? '#0d1117' : '#ffffff'
      const url = chart.getConvertPictureUrl(true, 'png', bg)
      const a = document.createElement('a')
      a.href = url
      a.download = `chart-${Date.now()}.png`
      a.click()
    } catch (err) {
      console.error('[client-chart] screenshot failed', err)
    }
  }

  const toggleFullscreen = (): void => {
    const el = fullscreenRef.current
    if (!el) return
    if (!document.fullscreenElement) {
      const req = el.requestFullscreen?.bind(el)
        ?? (el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen?.bind(el)
      void req?.()
    } else {
      void document.exitFullscreen?.()
    }
  }

  const mainInds = indicators.filter(i => i.group === 'main')
  const subInds = indicators.filter(i => i.group === 'sub')

  return (
    <div ref={wrapRef} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, position: 'relative' }}>
      <button
        type="button"
        style={BTN(!drawBarOpen, palette)}
        aria-label={drawBarOpen ? '收起画线栏' : '展开画线栏'}
        aria-pressed={drawBarOpen}
        title={drawBarOpen ? '收起左侧画线工具栏' : '展开左侧画线工具栏'}
        onClick={onToggleDrawBar}
      >☰</button>
      {/* 指标 */}
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          style={BTN(open === 'indicator', palette)}
          aria-expanded={open === 'indicator'}
          aria-label="指标"
          onClick={() => setOpen(o => o === 'indicator' ? null : 'indicator')}
        >指标</button>
        {open === 'indicator' ? (
          <div role="dialog" aria-label="指标快捷开关" style={PANEL(dark, palette)}>
            <SectionTitle>主图指标</SectionTitle>
            {mainInds.map(ind => (
              <CheckRow
                key={ind.name}
                checked={ind.visible}
                label={ind.title}
                onToggle={() => onToggleIndicator(ind.name)}
              />
            ))}
            {chips.filter(c => c.id === 'bb').map(c => (
              <CheckRow key={c.id} checked={c.on} label={c.title} onToggle={() => onToggleChip(c.id)} />
            ))}
            <SectionTitle>副图指标</SectionTitle>
            {subInds.map(ind => (
              <CheckRow
                key={ind.name}
                checked={ind.visible}
                label={ind.title}
                onToggle={() => onToggleIndicator(ind.name)}
              />
            ))}
            {chips.filter(c => c.id !== 'bb' && c.id !== 'ma').map(c => (
              <CheckRow key={c.id} checked={c.on} label={c.title} onToggle={() => onToggleChip(c.id)} />
            ))}
            <div style={{ borderTop: `1px solid ${palette.line}`, marginTop: 4, padding: '8px 12px' }}>
              <button
                type="button"
                onClick={() => { close(); onOpenParams() }}
                style={{
                  ...BTN(false, palette),
                  width: '100%',
                  justifyContent: 'center',
                }}
              >⚙ 详细参数…</button>
            </div>
          </div>
        ) : null}
      </div>

      {/* 时区 */}
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          style={BTN(open === 'timezone', palette)}
          aria-expanded={open === 'timezone'}
          aria-label="时区"
          title={`当前时区：${TIMEZONES.find(t => t.key === display.timezone)?.text ?? display.timezone}`}
          onClick={() => setOpen(o => o === 'timezone' ? null : 'timezone')}
        >时区</button>
        {open === 'timezone' ? (
          <div role="dialog" aria-label="选择时区" style={{ ...PANEL(dark, palette), minWidth: 180 }}>
            {TIMEZONES.map(tz => (
              <button
                key={tz.key}
                type="button"
                onClick={() => { patchDisplay({ timezone: tz.key }); close() }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '6px 12px', border: 'none', cursor: 'pointer', fontSize: 12,
                  background: tz.key === display.timezone ? (dark ? 'rgba(22,119,255,0.2)' : 'rgba(22,119,255,0.12)') : 'transparent',
                  color: tz.key === display.timezone ? '#1677ff' : 'inherit',
                  fontWeight: tz.key === display.timezone ? 600 : 400,
                }}
              >{tz.text}<span style={{ opacity: 0.55, marginLeft: 8, fontSize: 10 }}>{tz.key}</span></button>
            ))}
          </div>
        ) : null}
      </div>

      {/* 设置 */}
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          style={BTN(open === 'setting', palette)}
          aria-expanded={open === 'setting'}
          aria-label="设置"
          onClick={() => setOpen(o => o === 'setting' ? null : 'setting')}
        >设置</button>
        {open === 'setting' ? (
          <div role="dialog" aria-label="图表设置" style={{ ...PANEL(dark, palette), minWidth: 240, padding: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
              <span>蜡烛形态</span>
              <select
                value={display.candleType}
                onChange={e => patchDisplay({ candleType: e.target.value as CandleType })}
                style={{
                  background: dark ? '#111' : '#fff', color: 'inherit',
                  border: `1px solid ${palette.line}`, borderRadius: 4, fontSize: 11, padding: '2px 4px',
                }}
              >
                {CANDLE_TYPES.map(c => <option key={c.key} value={c.key}>{c.text}</option>)}
              </select>
            </label>
            <CheckRow checked={display.gridShow} label="显示网格" onToggle={() => patchDisplay({ gridShow: !display.gridShow })} />
            <CheckRow checked={display.lastPriceShow} label="最新价标记" onToggle={() => patchDisplay({ lastPriceShow: !display.lastPriceShow })} />
            <CheckRow checked={display.highPriceShow} label="最高价标记" onToggle={() => patchDisplay({ highPriceShow: !display.highPriceShow })} />
            <CheckRow checked={display.lowPriceShow} label="最低价标记" onToggle={() => patchDisplay({ lowPriceShow: !display.lowPriceShow })} />
            <div style={{ borderTop: `1px solid ${palette.line}`, marginTop: 6, paddingTop: 8 }}>
              <button
                type="button"
                onClick={() => { setDisplaySettings(DEFAULT_DISPLAY); close() }}
                style={{ ...BTN(false, palette), width: '100%', justifyContent: 'center' }}
              >恢复默认</button>
            </div>
          </div>
        ) : null}
      </div>

      <button
        type="button"
        style={BTN(false, palette)}
        aria-label="截屏"
        title="导出图表为 PNG"
        disabled={!chart}
        onClick={screenshot}
      >截屏</button>

      <button
        type="button"
        style={BTN(fullscreen, palette)}
        aria-label={fullscreen ? '退出全屏' : '全屏'}
        title={fullscreen ? '退出全屏' : '全屏显示图表'}
        onClick={toggleFullscreen}
      >{fullscreen ? '退出全屏' : '全屏'}</button>
    </div>
  )
}
