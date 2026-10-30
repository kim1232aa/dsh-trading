/**
 * Drawing overlays adapted from @klinecharts/pro extension/ (Apache-2.0).
 * https://github.com/klinecharts/pro/tree/main/src/extension
 *
 * klinecharts 10 core ships line/fibonacciLine/brush/annotation only.
 * Polygon / wave / extra fibonacci tools live here and are registered once.
 */
import { registerOverlay } from 'klinecharts'
import type { OverlayTemplate } from 'klinecharts'

import arrow from './arrow.js'
import circle from './circle.js'
import rect from './rect.js'
import parallelogram from './parallelogram.js'
import triangle from './triangle.js'
import fibonacciCircle from './fibonacciCircle.js'
import fibonacciSegment from './fibonacciSegment.js'
import fibonacciSpiral from './fibonacciSpiral.js'
import fibonacciSpeedResistanceFan from './fibonacciSpeedResistanceFan.js'
import fibonacciExtension from './fibonacciExtension.js'
import gannBox from './gannBox.js'
import threeWaves from './threeWaves.js'
import fiveWaves from './fiveWaves.js'
import eightWaves from './eightWaves.js'
import anyWaves from './anyWaves.js'
import abcd from './abcd.js'
import xabcd from './xabcd.js'

/** Overlay names registered from Pro templates (plus core fibonacciLine). */
export const PRO_OVERLAY_NAMES = [
  'arrow',
  'circle',
  'rect',
  'parallelogram',
  'triangle',
  'fibonacciCircle',
  'fibonacciSegment',
  'fibonacciSpiral',
  'fibonacciSpeedResistanceFan',
  'fibonacciExtension',
  'gannBox',
  'threeWaves',
  'fiveWaves',
  'eightWaves',
  'anyWaves',
  'abcd',
  'xabcd',
] as const

const TEMPLATES: OverlayTemplate[] = [
  arrow,
  circle,
  rect,
  parallelogram,
  triangle,
  fibonacciCircle,
  fibonacciSegment,
  fibonacciSpiral,
  fibonacciSpeedResistanceFan,
  fibonacciExtension,
  gannBox,
  threeWaves,
  fiveWaves,
  eightWaves,
  anyWaves,
  abcd,
  xabcd,
]

let registered = false

/** Idempotent — safe to call from ChartCard ensureRegistered. */
export function registerProOverlays(): void {
  if (registered) return
  registered = true
  for (const template of TEMPLATES) {
    registerOverlay(template)
  }
}

/** Test helper: reset the once-guard (does not unregister from klinecharts). */
export function __resetProOverlayRegistrationForTests(): void {
  registered = false
}
