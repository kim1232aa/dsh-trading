import { describe, expect, it } from 'vitest'
import { getSupportedOverlays } from 'klinecharts'
import {
  PRO_OVERLAY_NAMES,
  registerProOverlays,
  __resetProOverlayRegistrationForTests,
} from '../src/client/overlays/index.js'

describe('Pro drawing overlays (vendored from @klinecharts/pro)', () => {
  it('registers polygon / fibonacci / wave templates by name', () => {
    __resetProOverlayRegistrationForTests()
    registerProOverlays()
    const supported = new Set(getSupportedOverlays())
    for (const name of PRO_OVERLAY_NAMES) {
      expect(supported.has(name), `missing overlay ${name}`).toBe(true)
    }
  })

  it('is idempotent', () => {
    registerProOverlays()
    registerProOverlays()
    expect(getSupportedOverlays().filter(n => n === 'xabcd')).toHaveLength(1)
  })
})
