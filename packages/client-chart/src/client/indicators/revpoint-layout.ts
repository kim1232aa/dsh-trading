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
  // Any horizontal overflow means the anchor bar is (partly) scrolled out: hide
  // rather than show a fragment like "52.00 顺1H". Allow 2px of slack.
  if (bx < -2 || bx + w > paneW + 2) return null
  if (by + h <= 0 || by >= paneH) return null
  const x = Math.min(Math.max(0, bx), Math.max(0, paneW - w))
  const y = Math.min(Math.max(0, by), Math.max(0, paneH - h))
  return { x, y }
}

export type EdgeTagIn = { y: number; w: number; h: number; priority?: number }
export type EdgeTagOut = { x: number; y: number }

/**
 * Lay out right-edge HTF R/S tags so they sit left of the price axis and the
 * status table, never overlap each other, and — when the pane is too short —
 * drop lowest-priority tags first (returned as null) instead of piling up.
 */
export function layoutEdgeTags(
  tags: readonly EdgeTagIn[],
  paneW: number,
  paneH: number,
  table: Rect | null,
  priceAxisGap = PRICE_AXIS_GAP,
  gap = 2,
): (EdgeTagOut | null)[] {
  const rightLimit = paneW - priceAxisGap
  const placed: (EdgeTagOut | null)[] = new Array(tags.length).fill(null)
  const boxes: Rect[] = table ? [table] : []
  const hit = (a: Rect, b: Rect) => !(a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x || a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y)
  const order = tags.map((t, i) => ({ ...t, i })).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.y - b.y)
  for (const t of order) {
    const x = Math.max(0, rightLimit - t.w)
    const y0 = t.y - t.h / 2
    let done = false
    // Search outward from the level's own y for the nearest free slot (≤ 4 tag heights away).
    for (let k = 0; k <= 8 && !done; k++) {
      const dy = (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * (t.h + gap)
      const y = y0 + dy
      if (y < 0 || y + t.h > paneH) continue
      // Prefer the column at the right edge; if the table is there, shift left of it.
      for (const cx of table ? [x, table.x - 4 - t.w] : [x]) {
        if (cx < 0) continue
        const r = { x: cx, y, w: t.w, h: t.h }
        if (boxes.some(b => hit(r, b))) continue
        boxes.push(r); placed[t.i] = { x: cx, y }; done = true; break
      }
    }
  }
  // Hard guarantee: nothing may intersect the table, at any zoom.
  if (table) placed.forEach((p, i) => {
    if (p && rectsOverlap({ x: p.x, y: p.y, w: tags[i]!.w, h: tags[i]!.h }, table)) placed[i] = null
  })
  return placed
}

/** Status table form for a pane height: full table, a compact 2-row card, or nothing. */
export function tableMode(paneH: number, fullH: number): 'full' | 'compact' | 'hidden' {
  if (paneH >= fullH + 120) return 'full'
  if (paneH >= 110) return 'compact'
  return 'hidden'
}

/** Clip an extended ray's end x to the pane's right edge (Pine extend.right, but stop at the canvas). */
export function clipExtendX(x1: number, x2: number, paneW: number): number {
  if (x2 >= x1) return Math.min(x2, paneW)
  return Math.max(x2, 0)
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * klinecharts parks the fixed OHLC box top-right when the crosshair is on the left
 * half — over the RevPoint table and the right-edge pills. Return the rect
 * offsetRight that pushes that right-parked box all the way to the top-left
 * instead, so it never covers either.
 */
export function ohlcOffsetRightForTopLeft(paneW: number, boxW = 210, margin = 8): number {
  return Math.max(4, paneW - boxW - margin)
}
