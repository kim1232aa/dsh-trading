/**
 * Left drawing toolbar styled like KLineChart Pro DrawingBar:
 * cursor, singleLine, moreLine, polygon, fibonacci, wave, brush, annotation,
 * magnet, lock, eye, trash. Polygon/wave/fib extras registered from Pro overlays.
 * Icon paths + overlay templates adapted from @klinecharts/pro (Apache-2.0).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import type { Chart, OverlayMode } from 'klinecharts'
import {
  clearUserDrawings,
  createUserDrawing,
  setUserDrawLock,
  setUserDrawMagnet,
  setUserDrawVisible,
} from './kline-v10.js'
import {
  DRAW_ICON_MAP,
  IconChevron,
  IconCursor,
  IconLock,
  IconRemove,
  IconUnlock,
  IconInvisible,
  IconVisible,
} from './drawing-icons.js'

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
  | 'arrow'
  | 'priceLine'
  | 'priceChannelLine'
  | 'parallelStraightLine'
  | 'circle'
  | 'rect'
  | 'parallelogram'
  | 'triangle'
  | 'fibonacciLine'
  | 'fibonacciSegment'
  | 'fibonacciCircle'
  | 'fibonacciSpiral'
  | 'fibonacciSpeedResistanceFan'
  | 'fibonacciExtension'
  | 'gannBox'
  | 'xabcd'
  | 'abcd'
  | 'threeWaves'
  | 'fiveWaves'
  | 'eightWaves'
  | 'anyWaves'
  | 'brush'
  | 'simpleAnnotation'
  | 'simpleTag'

type ToolItem = { key: DrawToolName; text: string }

const SINGLE_LINE: ToolItem[] = [
  { key: 'horizontalStraightLine', text: '水平直线' },
  { key: 'horizontalRayLine', text: '水平射线' },
  { key: 'horizontalSegment', text: '水平线段' },
  { key: 'verticalStraightLine', text: '垂直直线' },
  { key: 'verticalRayLine', text: '垂直射线' },
  { key: 'verticalSegment', text: '垂直线段' },
  { key: 'straightLine', text: '直线' },
  { key: 'rayLine', text: '射线' },
  { key: 'segment', text: '线段' },
  { key: 'arrow', text: '箭头' },
  { key: 'priceLine', text: '价格线' },
]

const MORE_LINE: ToolItem[] = [
  { key: 'priceChannelLine', text: '价格通道线' },
  { key: 'parallelStraightLine', text: '平行直线' },
]

const POLYGON: ToolItem[] = [
  { key: 'circle', text: '圆' },
  { key: 'rect', text: '矩形' },
  { key: 'parallelogram', text: '平行四边形' },
  { key: 'triangle', text: '三角形' },
]

const FIBONACCI: ToolItem[] = [
  { key: 'fibonacciLine', text: '斐波那契回调直线' },
  { key: 'fibonacciSegment', text: '斐波那契段' },
  { key: 'fibonacciCircle', text: '斐波那契圈' },
  { key: 'fibonacciSpiral', text: '斐波那契螺旋' },
  { key: 'fibonacciSpeedResistanceFan', text: '斐波那契速度阻力扇' },
  { key: 'fibonacciExtension', text: '斐波那契延伸' },
  { key: 'gannBox', text: '江恩箱' },
]

const WAVE: ToolItem[] = [
  { key: 'xabcd', text: 'XABCD' },
  { key: 'abcd', text: 'ABCD' },
  { key: 'threeWaves', text: '三浪' },
  { key: 'fiveWaves', text: '五浪' },
  { key: 'eightWaves', text: '八浪' },
  { key: 'anyWaves', text: '任意浪' },
]

const ANNOTATION: ToolItem[] = [
  { key: 'simpleAnnotation', text: '简单标注' },
  { key: 'simpleTag', text: '简单标签' },
]

const MAGNETS: { key: OverlayMode; text: string }[] = [
  { key: 'weak_magnet', text: '弱磁模式' },
  { key: 'strong_magnet', text: '强磁模式' },
]

const BAR_W = 52

function iconOf(name: string, style?: CSSProperties): ReactElement {
  const Comp = DRAW_ICON_MAP[name] ?? IconCursor
  return <Comp style={style} />
}

function useClickOutside(open: string, onClose: () => void): React.RefObject<HTMLDivElement> {
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

function PopoverList({
  dark,
  items,
  onPick,
}: {
  dark: boolean
  items: { key: string; text: string; icon?: string }[]
  onPick: (key: string) => void
}): ReactElement {
  return (
    <ul
      role="menu"
      style={{
        position: 'absolute',
        top: 0,
        left: 'calc(100% + 1px)',
        zIndex: 10050,
        margin: 0,
        padding: '4px 0',
        listStyle: 'none',
        minWidth: 168,
        maxHeight: 320,
        overflowY: 'auto',
        whiteSpace: 'nowrap',
        background: dark ? '#1c1c1f' : '#ffffff',
        color: dark ? '#929AA5' : '#76808F',
        boxShadow: '0 6px 12px 0 rgba(0,0,0,.3)',
        borderRadius: 2,
      }}
    >
      {items.map(it => (
        <li key={it.key} role="none">
          <button
            type="button"
            role="menuitem"
            onClick={() => onPick(it.key)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '6px 16px 6px 12px',
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: 13,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = dark ? 'rgba(22,119,255,0.15)' : 'rgba(22,119,255,0.12)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            <span style={{ display: 'inline-flex', width: 22, height: 22, color: 'inherit' }}>
              {iconOf(it.icon ?? it.key)}
            </span>
            {it.text}
          </button>
        </li>
      ))}
    </ul>
  )
}

function GroupItem({
  dark,
  selected,
  iconName,
  title,
  open,
  onMainClick,
  onArrowClick,
  children,
}: {
  dark: boolean
  selected: boolean
  iconName: string
  title: string
  open: boolean
  onMainClick: () => void
  onArrowClick: () => void
  children?: ReactNode
}): ReactElement {
  const hoverBg = dark ? 'rgba(22,119,255,0.15)' : 'rgba(22,119,255,0.12)'
  const selectedBg = 'rgba(22,119,255,0.22)'
  const selectedFg = '#1677ff'
  const fg = dark ? '#929AA5' : '#76808F'
  return (
    <div
      className="dsh-draw-item"
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        marginTop: 8,
        color: selected ? selectedFg : fg,
        fill: 'currentColor',
      }}
    >
      <button
        type="button"
        title={title}
        aria-label={title}
        aria-pressed={selected}
        onClick={onMainClick}
        style={{
          width: 32,
          height: 32,
          padding: 0,
          border: 'none',
          borderRadius: 2,
          background: selected ? selectedBg : 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onMouseEnter={e => { if (!selected) e.currentTarget.style.background = hoverBg }}
        onMouseLeave={e => { e.currentTarget.style.background = selected ? selectedBg : 'transparent' }}
      >
        {iconOf(iconName)}
      </button>
      <button
        type="button"
        title="展开"
        aria-label={`${title}菜单`}
        aria-expanded={open}
        onClick={onArrowClick}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: 10,
          height: 32,
          padding: 0,
          border: 'none',
          borderRadius: '2px 0 0 2px',
          background: open ? hoverBg : 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: open ? 1 : undefined,
        }}
        className="dsh-draw-arrow"
      >
        <IconChevron open={open} />
      </button>
      {children}
    </div>
  )
}

function SoloItem({
  dark,
  selected,
  title,
  onClick,
  children,
}: {
  dark: boolean
  selected?: boolean
  title: string
  onClick: () => void
  children: ReactNode
}): ReactElement {
  const hoverBg = dark ? 'rgba(22,119,255,0.15)' : 'rgba(22,119,255,0.12)'
  const selectedBg = 'rgba(22,119,255,0.22)'
  const selectedFg = '#1677ff'
  const fg = dark ? '#929AA5' : '#76808F'
  return (
    <div style={{ display: 'flex', justifyContent: 'center', width: '100%', marginTop: 8, color: selected ? selectedFg : fg }}>
      <button
        type="button"
        title={title}
        aria-label={title}
        aria-pressed={selected === true}
        onClick={onClick}
        style={{
          width: 32,
          height: 32,
          padding: 0,
          border: 'none',
          borderRadius: 2,
          background: selected ? selectedBg : 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onMouseEnter={e => { if (!selected) e.currentTarget.style.background = hoverBg }}
        onMouseLeave={e => { e.currentTarget.style.background = selected ? selectedBg : 'transparent' }}
      >
        {children}
      </button>
    </div>
  )
}

export function ChartTools({
  chart,
  dark,
}: {
  chart: Chart | null
  dark: boolean
}): JSX.Element | null {
  const [magnetMode, setMagnetMode] = useState<OverlayMode>('normal')
  const [magnetIcon, setMagnetIcon] = useState<'weak_magnet' | 'strong_magnet'>('weak_magnet')
  const [lock, setLock] = useState(false)
  const [visible, setVisible] = useState(true)
  const [activeTool, setActiveTool] = useState<DrawToolName | null>(null)
  const [singleIcon, setSingleIcon] = useState<DrawToolName>('horizontalStraightLine')
  const [moreIcon, setMoreIcon] = useState<DrawToolName>('priceChannelLine')
  const [polygonIcon, setPolygonIcon] = useState<DrawToolName>('circle')
  const [fibIcon, setFibIcon] = useState<DrawToolName>('fibonacciLine')
  const [waveIcon, setWaveIcon] = useState<DrawToolName>('xabcd')
  const [annoIcon, setAnnoIcon] = useState<DrawToolName>('simpleAnnotation')
  const [popover, setPopover] = useState('')

  const closePopover = useCallback(() => setPopover(''), [])
  const barRef = useClickOutside(popover, closePopover)

  const startDraw = useCallback((name: DrawToolName) => {
    if (!chart) return
    setActiveTool(name)
    createUserDrawing(chart, name, {
      mode: magnetMode,
      lock,
      visible,
    })
  }, [chart, magnetMode, lock, visible])

  const togglePopover = useCallback((key: string) => {
    setPopover(prev => (prev === key ? '' : key))
  }, [])

  if (!chart) return null

  const border = dark ? '#292929' : '#ebedf1'
  const barBg = dark ? '#131316' : '#f5f6f8'
  const fg = dark ? '#929AA5' : '#76808F'

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="画线工具栏"
      data-testid="chart-tools"
      data-pro-style="drawing-bar"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        zIndex: 10040,
        width: BAR_W,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '4px 0 8px',
        background: barBg,
        borderRight: `1px solid ${border}`,
        color: fg,
        // overflowY:auto forces overflowX clip in browsers — keep visible so Pro submenus aren't cut.
        overflow: 'visible',
        pointerEvents: 'auto',
      }}
    >
      <style>{`
        [data-testid="chart-tools"] .dsh-draw-arrow { opacity: 0; transition: opacity .15s; }
        [data-testid="chart-tools"] .dsh-draw-item:hover .dsh-draw-arrow { opacity: 1; }
      `}</style>

      {/* Cursor — cancel interactive draw (Pro demos often show this first) */}
      <SoloItem
        dark={dark}
        selected={activeTool === null}
        title="选择（取消画线）"
        onClick={() => { setActiveTool(null); setPopover('') }}
      >
        <IconCursor />
      </SoloItem>

      {/* Single-line family */}
      <GroupItem
        dark={dark}
        selected={SINGLE_LINE.some(t => t.key === activeTool)}
        iconName={singleIcon}
        title={SINGLE_LINE.find(t => t.key === singleIcon)?.text ?? '线'}
        open={popover === 'singleLine'}
        onMainClick={() => startDraw(singleIcon)}
        onArrowClick={() => togglePopover('singleLine')}
      >
        {popover === 'singleLine' ? (
          <PopoverList
            dark={dark}
            items={SINGLE_LINE}
            onPick={(key) => {
              const k = key as DrawToolName
              setSingleIcon(k)
              startDraw(k)
              setPopover('')
            }}
          />
        ) : null}
      </GroupItem>

      {/* Channel / parallel — matches Pro「价格通道线 / 平行直线」 */}
      <GroupItem
        dark={dark}
        selected={MORE_LINE.some(t => t.key === activeTool)}
        iconName={moreIcon}
        title={MORE_LINE.find(t => t.key === moreIcon)?.text ?? '通道'}
        open={popover === 'moreLine'}
        onMainClick={() => startDraw(moreIcon)}
        onArrowClick={() => togglePopover('moreLine')}
      >
        {popover === 'moreLine' ? (
          <PopoverList
            dark={dark}
            items={MORE_LINE}
            onPick={(key) => {
              const k = key as DrawToolName
              setMoreIcon(k)
              startDraw(k)
              setPopover('')
            }}
          />
        ) : null}
      </GroupItem>

      {/* Polygon shapes — Pro createPolygonOptions */}
      <GroupItem
        dark={dark}
        selected={POLYGON.some(t => t.key === activeTool)}
        iconName={polygonIcon}
        title={POLYGON.find(t => t.key === polygonIcon)?.text ?? '多边形'}
        open={popover === 'polygon'}
        onMainClick={() => startDraw(polygonIcon)}
        onArrowClick={() => togglePopover('polygon')}
      >
        {popover === 'polygon' ? (
          <PopoverList
            dark={dark}
            items={POLYGON}
            onPick={(key) => {
              const k = key as DrawToolName
              setPolygonIcon(k)
              startDraw(k)
              setPopover('')
            }}
          />
        ) : null}
      </GroupItem>

      {/* Fibonacci family — Pro createFibonacciOptions */}
      <GroupItem
        dark={dark}
        selected={FIBONACCI.some(t => t.key === activeTool)}
        iconName={fibIcon}
        title={FIBONACCI.find(t => t.key === fibIcon)?.text ?? '斐波那契'}
        open={popover === 'fibonacci'}
        onMainClick={() => startDraw(fibIcon)}
        onArrowClick={() => togglePopover('fibonacci')}
      >
        {popover === 'fibonacci' ? (
          <PopoverList
            dark={dark}
            items={FIBONACCI}
            onPick={(key) => {
              const k = key as DrawToolName
              setFibIcon(k)
              startDraw(k)
              setPopover('')
            }}
          />
        ) : null}
      </GroupItem>

      {/* Wave / harmonic — Pro createWaveOptions */}
      <GroupItem
        dark={dark}
        selected={WAVE.some(t => t.key === activeTool)}
        iconName={waveIcon}
        title={WAVE.find(t => t.key === waveIcon)?.text ?? '波浪'}
        open={popover === 'wave'}
        onMainClick={() => startDraw(waveIcon)}
        onArrowClick={() => togglePopover('wave')}
      >
        {popover === 'wave' ? (
          <PopoverList
            dark={dark}
            items={WAVE}
            onPick={(key) => {
              const k = key as DrawToolName
              setWaveIcon(k)
              startDraw(k)
              setPopover('')
            }}
          />
        ) : null}
      </GroupItem>

      {/* Brush */}
      <SoloItem
        dark={dark}
        selected={activeTool === 'brush'}
        title="笔刷"
        onClick={() => startDraw('brush')}
      >
        {iconOf('brush')}
      </SoloItem>

      {/* Annotation family */}
      <GroupItem
        dark={dark}
        selected={ANNOTATION.some(t => t.key === activeTool)}
        iconName={annoIcon}
        title={ANNOTATION.find(t => t.key === annoIcon)?.text ?? '标注'}
        open={popover === 'annotation'}
        onMainClick={() => startDraw(annoIcon)}
        onArrowClick={() => togglePopover('annotation')}
      >
        {popover === 'annotation' ? (
          <PopoverList
            dark={dark}
            items={ANNOTATION}
            onPick={(key) => {
              const k = key as DrawToolName
              setAnnoIcon(k)
              startDraw(k)
              setPopover('')
            }}
          />
        ) : null}
      </GroupItem>

      <div style={{ width: '100%', height: 1, background: border, marginTop: 8 }} />

      {/* Magnet */}
      <GroupItem
        dark={dark}
        selected={magnetMode !== 'normal'}
        iconName={magnetIcon}
        title={magnetMode === 'normal' ? '磁吸（关）' : MAGNETS.find(m => m.key === magnetMode)?.text ?? '磁吸'}
        open={popover === 'magnet'}
        onMainClick={() => {
          // Pro: click icon toggles between normal and last magnet mode
          const next: OverlayMode = magnetMode === 'normal' ? magnetIcon : 'normal'
          setMagnetMode(next)
          setUserDrawMagnet(chart, next)
        }}
        onArrowClick={() => togglePopover('magnet')}
      >
        {popover === 'magnet' ? (
          <PopoverList
            dark={dark}
            items={MAGNETS.map(m => ({ key: m.key, text: m.text, icon: m.key }))}
            onPick={(key) => {
              const mode = key as OverlayMode
              setMagnetIcon(mode === 'strong_magnet' ? 'strong_magnet' : 'weak_magnet')
              setMagnetMode(mode)
              setUserDrawMagnet(chart, mode)
              setPopover('')
            }}
          />
        ) : null}
      </GroupItem>

      <SoloItem
        dark={dark}
        selected={lock}
        title={lock ? '解锁画线' : '锁定画线'}
        onClick={() => {
          const next = !lock
          setLock(next)
          setUserDrawLock(chart, next)
        }}
      >
        {lock ? <IconLock /> : <IconUnlock />}
      </SoloItem>

      <SoloItem
        dark={dark}
        selected={!visible}
        title={visible ? '隐藏画线' : '显示画线'}
        onClick={() => {
          const next = !visible
          setVisible(next)
          setUserDrawVisible(chart, next)
        }}
      >
        {visible ? <IconVisible /> : <IconInvisible />}
      </SoloItem>

      <SoloItem
        dark={dark}
        title="清除手动画线"
        onClick={() => {
          clearUserDrawings(chart)
          setActiveTool(null)
        }}
      >
        <IconRemove />
      </SoloItem>
    </div>
  )
}
