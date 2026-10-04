/**
 * The trading shell frame — 0.2 compatible.
 *
 * Four columns: sidebar | chart | main(keyed) | rightbar, plus overlays.
 * Uses stock 0.2 slot names so ui-sidebar, ui-conversation, ui-sidebar-right
 * mount unchanged.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { computeColumns, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT } from './columns.js'
import { styles } from './styles.js'

// ponytail: 0.2 PropsRuntime<'root'> doesn't compile (SlotMap constraint);
// runtime shape is stable. Drop Record<string,any> when upstream types catch up.
export type TradingFrameProps = Record<string, any>

function CenterColumn(props: { children: ReactNode }) {
  return <div className={styles.centerCol}>{props.children}</div>
}

function ChartColumn(props: { children: ReactNode }) {
  return <div className={styles.chartCol}>{props.children}</div>
}

function ChartPlaceholder() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', opacity: 0.4 }}>
      Register a component into the <code>trading.chart</code> slot to fill it.
    </div>
  )
}

/** Right column grid item — wraps the rightbar slot. */
function RightbarColumn(props: { children: ReactNode }) {
  return <div className={styles.detailsCol}>{props.children}</div>
}

function DragHandle(props: {
  side: 'sidebar' | 'chart' | 'details'
  left: number
  onStart: () => void
  onDrag: (dx: number) => void
  onEnd: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    setDragging(true)
    props.onStart()
  }, [props.onStart])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      props.onDrag(latest.current - origin.current)
    })
  }, [dragging, props.onDrag])

  const onPointerUp = useCallback(() => {
    setDragging(false)
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
    props.onEnd()
  }, [props.onEnd])

  return (
    <div
      className={styles.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

/** The four-column frame. */
export function TradingFrame({ useStore, usePanelInfo, actions, renderSlot }: TradingFrameProps) {
  const panels = useStore((s: any) => s)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 1280)

  // Measure frame width via ResizeObserver.
  useEffect(() => {
    const el = frameRef.current
    if (el === null) return
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? el.getBoundingClientRect().width
      if (width > 0) {
        setViewport(prev => prev === width ? prev : width)
        actions.setViewportWidth(width)
      }
    })
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [actions])

  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  useEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])

  const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0
  const cols = computeColumns(
    viewport,
    sidebarCollapsed ? 0 : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar,
    panels.chart,
    0, // rightbar width handled by stock rightbar slot
  )

  const colsRef = useRef(cols)
  colsRef.current = cols

  const sidebarBase = useRef(0)
  const chartBase = useRef(0)
  const [dragging, setDragging] = useState(false)

  const onDragEnd = useCallback(() => setDragging(false), [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar }, [])
  const onChartStart = useCallback(() => { chartBase.current = colsRef.current.chart; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => actions.setSidebar(sidebarBase.current + dx), [actions])
  const onChartDrag = useCallback((dx: number) => {
    const c = colsRef.current; const room = c.chart + c.center
    if (room > 0) actions.setChart((chartBase.current + dx) / room)
  }, [actions])

  // Stock 0.2: select keyed 'main' entry by panelInfo.
  const activePanelId = usePanelInfo?.((info: any) => info.activePanelId) ?? null
  const main = useMemo(
    () => renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' }),
    [renderSlot, activePanelId],
  )
  const rightbar = useMemo(
    () => renderSlot('rightbar', { width: 0, viewportWidth: viewport, canShow: false }),
    [renderSlot, viewport],
  )
  const overlays = useMemo(() => renderSlot('shell.overlay', {}), [renderSlot])

  return (
    <div
      ref={frameRef}
      className={styles.frame}
      style={{
        gridTemplateColumns: `${cols.sidebar}px ${cols.chart}px minmax(0, 1fr) 0px`,
      }}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-chart-collapsed={cols.chart === 0 || undefined}
      data-dragging={dragging || undefined}
    >
      <div className={styles.sidebarCol}>
        {renderSlot('sidebar', { collapsed: sidebarCollapsed, width: cols.sidebar })}
      </div>
      <ChartColumn>
        {renderSlot('trading.chart', { width: cols.chart }, { fallback: <ChartPlaceholder /> })}
      </ChartColumn>
      <>
        <CenterColumn>{main}</CenterColumn>
        <RightbarColumn>{rightbar}</RightbarColumn>
      </>
      <div className={styles.overlayLayer} data-shell-overlay>
        {overlays}
      </div>
      {!sidebarCollapsed && (
        <DragHandle side="sidebar" left={cols.sidebar}
          onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />
      )}
      {cols.chart > 0 && (
        <DragHandle side="chart" left={cols.sidebar + cols.chart}
          onStart={onChartStart} onDrag={onChartDrag} onEnd={onDragEnd} />
      )}
    </div>
  )
}
