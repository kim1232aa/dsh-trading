import { describe, expect, it } from 'vitest'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Every host plugin must export apply + an inject ARRAY of service names.
// cordis treats each key of an inject map as required, and a bare default
// function export is resolved as the plugin itself (losing `inject`).
const root = join(__dirname, '..', 'packages')
const pkgs = readdirSync(root).filter(p => existsSync(join(root, p, 'src', 'index.ts')))

describe('plugin module shape', () => {
  for (const p of pkgs) {
    it(p, async () => {
      const mod = await import(join(root, p, 'src', 'index.ts'))
      if (typeof mod.apply !== 'function') return // library-only package
      expect(Array.isArray(mod.inject ?? [])).toBe(true)
      for (const s of mod.inject ?? []) expect(['tools', 'marketData']).toContain(s)
      if (typeof mod.default === 'function') expect(mod.default).not.toBe(mod.apply)
    })
  }
})
