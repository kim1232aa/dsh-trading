import { describe, expect, it, vi } from 'vitest'
import type { Coordinate, OverlayCreateFiguresCallbackParams, OverlayFigure, TextAttrs } from 'klinecharts'
import { createAnnotationOverlays } from '../src/client/annotation-overlays.js'

const measure = vi.fn((text: string) => Array.from(text).reduce((width, ch) =>
  width + (ch === 'W' ? 14 : ch === 'i' ? 3 : ch.codePointAt(0)! > 255 ? 11 : 6), 0))
const templates = createAnnotationOverlays('Test Font', measure)

type Options = { width?: number; height?: number; label?: string; lane?: number }
function render(name: string, coordinates: Coordinate[], options: Options = {}): OverlayFigure[] {
  const { width = 1000, height = 500, label = '今日低点', lane = 0 } = options
  const template = templates.find(t => t.name === name)!
  const result = template.createPointFigures!({
    coordinates, bounding: { width, height, left: 0, right: width, top: 0, bottom: height },
    overlay: { extendData: { label, lane, color: '#00ff00', dashed: true } },
  } as OverlayCreateFiguresCallbackParams)
  return Array.isArray(result) ? result : [result]
}

function caption(figures: OverlayFigure[]): TextAttrs | undefined {
  return figures.find(f => f.type === 'text')?.attrs as TextAttrs | undefined
}

function expectInside(text: TextAttrs | undefined, width = 1000, height = 500): void {
  expect(text).toBeDefined()
  expect(text!.align).toBe('right')
  expect(text!.baseline).toBe('bottom')
  expect(text!.width).toBeGreaterThan(0)
  expect(text!.height).toBeGreaterThan(0)
  expect(text!.x - text!.width!).toBeGreaterThanOrEqual(0)
  expect(text!.x).toBeLessThanOrEqual(width)
  expect(text!.y - text!.height!).toBeGreaterThanOrEqual(0)
  expect(text!.y).toBeLessThanOrEqual(height)
}

const path = [{ x: 100, y: 180 }, { x: 600, y: 140 }]

describe('production annotation overlay callbacks', () => {
  it('preserves two anchors and keeps the caption in the pane', () => {
    const input = path.map(p => ({ ...p }))
    const figures = render('tm_polyline', input)
    expect(figures[0]!.attrs.coordinates).toEqual(path)
    expect(input).toEqual(path)
    expect(caption(figures)!.x).toBe(600)
    expectInside(caption(figures))
  })

  it('preserves all ABC vertices instead of replacing the final leg', () => {
    const abc = [{ x: 100, y: 100 }, { x: 200, y: 200 }, { x: 300, y: 120 }, { x: 400, y: 240 }]
    const figures = render('tm_polyline', abc, { label: 'ABC路径' })
    expect(figures[0]!.attrs.coordinates).toEqual(abc)
    expect(figures[0]!.attrs.coordinates.at(-1)).toEqual({ x: 400, y: 240 })
    expectInside(caption(figures))
  })

  it('preserves an explicit projection endpoint supplied by the producer', () => {
    const projected = [...path, { x: 850, y: 120 }]
    const figures = render('tm_polyline', projected)
    expect(figures[0]!.attrs.coordinates).toEqual(projected)
    expect(caption(figures)!.x).toBe(850)
  })

  it.each([
    ['right', [{ x: 100, y: 100 }, { x: 1200, y: 300 }]],
    ['top', [{ x: 100, y: 200 }, { x: 1200, y: -100 }]],
    ['bottom', [{ x: 100, y: 200 }, { x: 600, y: 700 }]],
    ['left', [{ x: 600, y: 200 }, { x: -100, y: 300 }]],
    ['vertical', [{ x: 250, y: 200 }, { x: 250, y: -100 }]],
    ['horizontal crossing', [{ x: -100, y: 200 }, { x: 1200, y: 200 }]],
  ])('labels the visible %s segment without changing its coordinates', (_, coordinates) => {
    const figures = render('tm_polyline', coordinates as Coordinate[])
    expect(figures[0]!.attrs.coordinates).toEqual(coordinates)
    expectInside(caption(figures))
  })

  it('uses the last visible segment when the final segment is entirely outside', () => {
    const points = [{ x: 100, y: 200 }, { x: 1200, y: 200 }, { x: 1300, y: 250 }]
    const text = caption(render('tm_polyline', points))
    expect(text!.x).toBe(994)
    expectInside(text)
  })

  it.each([
    [{ x: 1100, y: 100 }, { x: 1200, y: 200 }],
    [{ x: 100, y: -100 }, { x: 200, y: -50 }],
  ])('does not leave a caption for a completely offscreen path', (a, b) => {
    const figures = render('tm_polyline', [a, b])
    expect(figures).toHaveLength(1)
    expect(caption(figures)).toBeUndefined()
  })

  it('handles coincident vertices without nonfinite label coordinates', () => {
    expectInside(caption(render('tm_polyline', [{ x: 200, y: 200 }, { x: 200, y: 200 }])))
  })

  it('ignores incomplete or nonfinite paths', () => {
    expect(render('tm_polyline', [{ x: 100, y: 100 }])).toEqual([])
    expect(render('tm_polyline', [{ x: 100, y: 100 }, { x: NaN, y: 200 }])).toEqual([])
  })

  it('uses measured text width and an actual right-aligned anchor', () => {
    const figures = render('tm_hline', [{ x: 0, y: 200 }], { label: 'Wi今日' })
    const text = caption(figures)!
    expect(text.x).toBe(994)
    expect(text.width).toBe(14 + 3 + 22 + 6)
    expect(measure).toHaveBeenCalledWith('Wi今日', expect.objectContaining({ family: 'Test Font', size: 11, weight: 500 }))
    expect(figures.find(f => f.type === 'text')!.styles.align).toBeUndefined()
    expectInside(text)
  })

  it('ellipsizes a long CJK caption in a 220px pane', () => {
    const label = '今日探底缓冲带(09-10低点-今日低点)'
    const text = caption(render('tm_hline', [{ x: 0, y: 200 }], { width: 220, label }))!
    expect(text.text).toMatch(/…$/)
    expect(text.text.length).toBeLessThan(label.length)
    expect(text.width).toBe(measure(text.text) + 6)
    expectInside(text, 220)
  })

  it('keeps long captions in adjacent lanes from overlapping horizontally', () => {
    const label = '较长的中文支撑阻力说明需要缩略'
    const right = caption(render('tm_hline', [{ x: 0, y: 200 }], { label, lane: 0 }))!
    const left = caption(render('tm_hline', [{ x: 0, y: 200 }], { label, lane: 1 }))!
    expect(left.x).toBeLessThan(right.x - right.width!)
  })

  it('hides captions when a pane or lane cannot fit a meaningful label', () => {
    for (const options of [{ width: 22 }, { width: 160, lane: 1 }, { height: 20 }, { lane: -1 }]) {
      const figures = render('tm_hline', [{ x: 0, y: 10 }], options)
      expect(figures[0]!.type).toBe('line')
      expect(caption(figures)).toBeUndefined()
    }
  })

  it.each([0, 500])('keeps a horizontal caption inside at y=%s', y => {
    expectInside(caption(render('tm_hline', [{ x: 0, y }])))
  })

  it.each([-1, 501])('hides the caption of an offscreen horizontal line at y=%s', y => {
    expect(caption(render('tm_hline', [{ x: 0, y }]))).toBeUndefined()
  })

  it('labels a partly visible region without changing the region bounds', () => {
    const figures = render('tm_region', [{ x: 0, y: -100 }, { x: 0, y: 100 }])
    expect(figures[0]!.attrs).toEqual({ x: 0, y: -100, width: 1000, height: 200 })
    expectInside(caption(figures))
  })

  it('hides captions for completely offscreen regions', () => {
    expect(caption(render('tm_region', [{ x: 0, y: -100 }, { x: 0, y: -50 }]))).toBeUndefined()
  })

  it('recomputes caption bounds for a resized viewport', () => {
    for (const width of [1000, 400, 220, 80]) {
      const visiblePath = [{ x: 20, y: 180 }, { x: 600, y: 140 }]
      expectInside(caption(render('tm_polyline', visiblePath, { width, label: '很长的趋势线说明' })), width)
    }
  })

  it('keeps locked complete overlays out of the interactive drawing slot', () => {
    expect(templates.map(t => [t.name, t.totalStep, t.lock])).toEqual([
      ['tm_hline', 2, true], ['tm_region', 3, true], ['tm_polyline', 2, true],
    ])
  })
})
