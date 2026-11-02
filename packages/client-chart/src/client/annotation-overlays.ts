import type { Bounding, Coordinate, OverlayFigure, OverlayTemplate, TextStyle } from 'klinecharts'

type MeasureText = (text: string, style: Pick<TextStyle, 'size' | 'weight' | 'family'>) => number
const MARGIN = 6
const LABEL_HEIGHT = 13
const LABEL_LANE_WIDTH = 150
const LABEL_GAP = 8

/** Last visible point of a segment; never modifies the path being drawn. */
function visibleSegmentEnd(a: Coordinate, b: Coordinate, bounds: Bounding): Coordinate | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  let start = 0
  let end = 1
  const edges: [number, number][] = [[-dx, a.x], [dx, bounds.width - a.x], [-dy, a.y], [dy, bounds.height - a.y]]
  for (const [direction, distance] of edges) {
    if (direction === 0) {
      if (distance < 0) return null
      continue
    }
    const t = distance / direction
    if (direction < 0) start = Math.max(start, t)
    else end = Math.min(end, t)
    if (start > end) return null
  }
  return { x: a.x + dx * end, y: a.y + dy * end }
}

/** "MM-DD HH:mm" of a vertex in the chart's timezone; UTC when the zone is unknown. */
export function vertexTimeText(timestamp: number, timezone: string | undefined): string {
  if (!Number.isFinite(timestamp)) return ''
  const fmt = (timeZone: string): string => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(timestamp))
    const get = (type: string): string => parts.find(p => p.type === type)?.value ?? ''
    return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
  }
  try {
    return fmt(timezone !== undefined && timezone !== '' ? timezone : 'UTC')
  } catch {
    return fmt('UTC')
  }
}

/** Shared by production registration and callback regression tests. */
export function createAnnotationOverlays(family: string, measureText: MeasureText): OverlayTemplate[] {
  const textStyle = {
    size: 11, weight: 500, family,
    backgroundColor: 'rgba(22,24,28,0.72)', borderRadius: 2, borderSize: 0,
    paddingLeft: 3, paddingRight: 3, paddingTop: 1, paddingBottom: 1,
  }
  const measuredWidth = (text: string): number => Math.ceil(measureText(text, textStyle)) + 6

  function fitText(text: string, available: number): { text: string; width: number } | null {
    const width = measuredWidth(text)
    if (!Number.isFinite(width) || width < 6) return null
    if (width <= available) return { text, width }
    const chars = Array.from(text)
    let low = 0
    let high = chars.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (measuredWidth(chars.slice(0, middle).join('') + '…') <= available) low = middle
      else high = middle - 1
    }
    if (low === 0) return null
    const fitted = chars.slice(0, low).join('') + '…'
    return { text: fitted, width: measuredWidth(fitted) }
  }

  function caption(label: unknown, color: string, anchor: Coordinate, bounds: Bounding,
    available = bounds.width - 2 * MARGIN): OverlayFigure[] {
    if (typeof label !== 'string' || label === '' || !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height) || bounds.height < LABEL_HEIGHT + 2 * MARGIN ||
      !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return []
    const fitted = fitText(label, Math.min(available, bounds.width - 2 * MARGIN))
    if (fitted === null) return []
    const x = Math.min(bounds.width - MARGIN, Math.max(MARGIN + fitted.width, anchor.x))
    const y = Math.min(bounds.height - MARGIN, Math.max(MARGIN + LABEL_HEIGHT, anchor.y - 4))
    return [{
      type: 'text',
      attrs: { x, y, text: fitted.text, width: fitted.width, height: LABEL_HEIGHT, align: 'right', baseline: 'bottom' },
      styles: { ...textStyle, color },
      ignoreEvent: true,
    }]
  }

  function laneCaption(ext: Record<string, unknown>, color: string, y: number, bounds: Bounding): OverlayFigure[] {
    const lane = typeof ext['lane'] === 'number' ? ext['lane'] : 0
    if (!Number.isInteger(lane) || lane < 0) return []
    const right = bounds.width - MARGIN - lane * LABEL_LANE_WIDTH
    // Keep neighbouring lanes separate; a narrow pane may have no room for a lane.
    const available = Math.min(LABEL_LANE_WIDTH - LABEL_GAP, right - MARGIN)
    return caption(ext['label'], color, { x: right, y }, bounds, available)
  }

  return [{
    name: 'tm_hline', totalStep: 2, lock: true,
    createPointFigures: ({ coordinates, bounding, overlay }) => {
      const y = coordinates[0]?.y
      if (y === undefined || !Number.isFinite(y)) return []
      const ext = (overlay.extendData ?? {}) as Record<string, unknown>
      const color = typeof ext['color'] === 'string' ? ext['color'] : '#888888'
      const figures: OverlayFigure[] = [{
        type: 'line', attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] },
        styles: { style: ext['dashed'] === true ? 'dashed' : 'solid', color }, ignoreEvent: true,
      }]
      if (y >= 0 && y <= bounding.height) figures.push(...laneCaption(ext, color, y, bounding))
      return figures
    },
  }, {
    name: 'tm_region', totalStep: 3, lock: true,
    createPointFigures: ({ coordinates, bounding, overlay }) => {
      const y0 = coordinates[0]?.y
      const y1 = coordinates[1]?.y
      if (y0 === undefined || y1 === undefined || !Number.isFinite(y0) || !Number.isFinite(y1)) return []
      const ext = (overlay.extendData ?? {}) as Record<string, unknown>
      const color = typeof ext['color'] === 'string' ? ext['color'] : '#888888'
      const top = Math.min(y0, y1)
      const bottom = Math.max(y0, y1)
      const originX = ext['anchored'] === true ? coordinates[0]?.x : 0
      if (originX === undefined || !Number.isFinite(originX)) return []
      const left = Math.max(0, originX)
      if (left >= bounding.width) return []
      const confirmationX = coordinates[2]?.x
      if (ext['knownAfterConfirmation'] === true &&
        (confirmationX === undefined || !Number.isFinite(confirmationX) || confirmationX > bounding.width)) return []
      const figures: OverlayFigure[] = [{
        type: 'rect', attrs: { x: left, y: top, width: bounding.width - left, height: bottom - top },
        styles: { style: 'fill', color: `${color}26` }, ignoreEvent: true,
      }]
      if (ext['knownAfterConfirmation'] === true && confirmationX !== undefined && confirmationX >= left) {
        figures.push({ type: 'line', attrs: { coordinates: [{ x: confirmationX, y: top }, { x: confirmationX, y: bottom }] },
          styles: { style: 'dashed', color }, ignoreEvent: true })
      }
      if (bottom >= 0 && top <= bounding.height) {
        figures.push(...laneCaption(ext, color, Math.max(0, top), bounding))
      }
      return figures
    },
  }, {
    // Finish supplied paths immediately; they must never enter interactive drawing.
    name: 'tm_polyline', totalStep: 2, lock: true,
    createPointFigures: ({ coordinates, bounding, overlay, chart }) => {
      if (coordinates.length < 2 || coordinates.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return []
      const ext = (overlay.extendData ?? {}) as Record<string, unknown>
      const color = typeof ext['color'] === 'string' ? ext['color'] : '#888888'
      const figures: OverlayFigure[] = [{
        type: 'line', attrs: { coordinates: [...coordinates] },
        styles: { style: ext['dashed'] === true ? 'dashed' : 'solid', color }, ignoreEvent: true,
      }]
      if (bounding.width <= 0 || bounding.height <= 0) return figures
      for (let i = coordinates.length - 1; i > 0; i--) {
        const anchor = visibleSegmentEnd(coordinates[i - 1]!, coordinates[i]!, bounding)
        if (anchor !== null) {
          figures.push(...caption(ext['label'], color, anchor, bounding))
          break
        }
      }
      // Timed vertex captions (event scripts): a dot on the vertex plus
      // "MM-DD HH:mm note" in the chart timezone. A vertex above/below the pane
      // keeps its caption pinned to that edge with an arrow, so a projected
      // target outside the candle range is still readable without squashing Y.
      const notes = Array.isArray(ext['vertexNotes']) ? ext['vertexNotes'] as unknown[] : []
      if (notes.length > 0) {
        let timezone: string | undefined
        try { timezone = (chart as { getTimezone?: () => string } | undefined)?.getTimezone?.() } catch { timezone = undefined }
        coordinates.forEach((pt, i) => {
          const note = notes[i]
          if (typeof note !== 'string' || note === '') return
          if (pt.x < 0 || pt.x > bounding.width) return
          const ts = overlay.points?.[i]?.timestamp
          const when = typeof ts === 'number' ? vertexTimeText(ts, timezone) : ''
          const text = when !== '' ? `${when} ${note}` : note
          if (pt.y >= 0 && pt.y <= bounding.height) {
            figures.push({ type: 'circle', attrs: { x: pt.x, y: pt.y, r: 3 }, styles: { style: 'fill', color }, ignoreEvent: true })
            figures.push(...caption(text, color, pt, bounding, LABEL_LANE_WIDTH + 40))
          } else {
            const edge = pt.y < 0 ? '↑ ' : '↓ '
            figures.push(...caption(edge + text, color, { x: pt.x, y: pt.y < 0 ? 0 : bounding.height }, bounding, LABEL_LANE_WIDTH + 40))
          }
        })
      }
      return figures
    },
  }]
}
