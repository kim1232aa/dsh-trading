/**
 * Pure layout helpers for the RevPoint overlay: status-table pinning,
 * right-edge tag collision resolution, and off-screen label clamping.
 */

export type Rect = { x: number; y: number; w: number; h: number }

/** Gap reserved for the y-axis tick labels on the right of the candle pane. */
export const PRICE_AXIS_GAP = 88

/** Pin the status table to the true top-right of the pane, leaving the price axis clear. */
export function statusTableRect(paneW: number, tableW: number, tableH: number, priceAxisGap = PRICE_AXIS_GAP): Rect {
  return {
    x: Math.max(0, paneW - tableW - priceAxisGap),
    y: 8,
    w: tableW,
    h: tableH,
  }
}

/**
 * Clamp a label box into the pane. Returns null when the anchor is so far
 * off-screen that the label would only show a truncated fragment (e.g. "0 顺1H").
 */
export function clampLabelBox(
  bx: number,
  by: number,
  w: number,
  h: number,
  paneW: number,
  paneH: number,
): { x: number; y: number } | null {
  // Entirely outside → hide.
  if (bx + w <= 0 || bx >= paneW || by + h <= 0 || by >= paneH) return null
  // More than half hangs off the left (typical for a mark scrolled out of view) → hide.
  if (bx + w * 0.5 < 0) return null
  const x = Math.min(Math.max(0, bx), Math.max(0, paneW - w))
  const y = Math.min(Math.max(0, by), Math.max(0, paneH - h))
  return { x, y }
}

export type EdgeTagIn = { y: number; w: number; h: number }
export type EdgeTagOut = { x: number; y: number }

/**
 * Lay out right-edge HTF R/S tags so they:
 * - sit left of the price axis,
 * - sit left of the status table (no overlap, prefixes stay visible),
 * - do not stack on top of each other (nudge down on collision).
 */
export function layoutEdgeTags(
  tags: readonly EdgeTagIn[],
  paneW: number,
  paneH: number,
  table: Rect | null,
  priceAxisGap = PRICE_AXIS_GAP,
  gap = 2,
): EdgeTagOut[] {
  const rightLimit = table !== null
    ? Math.min(paneW - priceAxisGap, table.x - 4)
    : paneW - priceAxisGap
  const order = tags.map((t, i) => ({ ...t, i })).sort((a, b) => a.y - b.y)
  const placed: EdgeTagOut[] = new Array(tags.length)
  let lastBottom = -Infinity
  for (const t of order) {
    let y = t.y - t.h / 2
    if (y < lastBottom + gap) y = lastBottom + gap
    if (y + t.h > paneH) y = Math.max(0, paneH - t.h)
    let x = rightLimit - t.w
    if (table !== null) {
      const hitX = !(x + t.w <= table.x || x >= table.x + table.w)
      const hitY = !(y + t.h <= table.y || y >= table.y + table.h)
      if (hitX && hitY) {
        x = table.x - 4 - t.w
        if (x < 0) {
          x = Math.max(0, rightLimit - t.w)
          y = Math.max(y, table.y + table.h + gap)
        }
      }
    }
    if (x < 0) x = 0
    placed[t.i] = { x, y }
    lastBottom = y + t.h
  }
  return placed
}

/** Clip an extended ray's end x to the pane's right edge (Pine extend.right, but stop at the canvas). */
export function clipExtendX(x1: number, x2: number, paneW: number): number {
  if (x2 >= x1) return Math.min(x2, paneW)
  return Math.max(x2, 0)
}
