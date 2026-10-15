import { describe, expect, it } from 'vitest'
import type { OverlayFigure } from 'klinecharts'
import { createAnnotationOverlays } from '../src/client/annotation-overlays.js'

function drawRegion(x: number, width = 320, anchored = true, availableX?: number, gate = false): OverlayFigure[] {
  const region = createAnnotationOverlays('sans-serif', text => text.length * 7).find(o => o.name === 'tm_region')!
  return region.createPointFigures!({ coordinates: [{ x, y: 60 }, { x, y: 90 },
    ...availableX === undefined ? [] : [{ x: availableX, y: 60 }]],
    bounding: { width, height: 200, left: 0, right: width, top: 0, bottom: 200 },
    overlay: { extendData: { anchored, knownAfterConfirmation: gate, label: '15m供给候选', color: '#ef4444' } },
  } as never) as OverlayFigure[]
}

describe('formation-anchored supply zone boxes', () => {
  it.each([375, 768, 1440])('starts at the actual base on a %dpx pane', width => {
    const box = drawRegion(100, width).find(f => f.type === 'rect')!
    expect(box.attrs).toMatchObject({ x: 100, width: width - 100, y: 60, height: 30 })
  })
  it('clips a pre-window origin to the left edge', () => {
    expect(drawRegion(-100).find(f => f.type === 'rect')!.attrs).toMatchObject({ x: 0, width: 320 })
  })
  it('omits a future/offscreen or non-finite origin', () => {
    expect(drawRegion(400)).toEqual([])
    expect(drawRegion(Number.NaN)).toEqual([])
  })
  it.each([undefined, Number.NaN, 321])('does not reveal a candidate before it is known (%s)', availableX => {
    expect(drawRegion(100, 320, true, availableX, true)).toEqual([])
  })
  it('starts at the base but marks when its confirmation became known', () => {
    const figures = drawRegion(100, 320, true, 200, true)
    expect(figures.find(f => f.type === 'rect')?.attrs).toMatchObject({ x: 100, width: 220 })
    expect(figures.find(f => f.type === 'line')?.attrs).toMatchObject({ coordinates: [{ x: 200, y: 60 }, { x: 200, y: 90 }] })
  })
  it('keeps unanchored reference bands backwards compatible', () => {
    expect(drawRegion(100, 320, false).find(f => f.type === 'rect')!.attrs).toMatchObject({ x: 0, width: 320 })
  })
})
