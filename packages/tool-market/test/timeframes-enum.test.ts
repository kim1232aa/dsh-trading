import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '../src/index.ts'), 'utf8')

describe('tool-market TIMEFRAMES enum', () => {
  it('exposes the expanded interval set in the source enum', () => {
    for (const tf of ['3m', '2h', '6h', '8h', '12h', '3d', '1M']) {
      expect(src).toMatch(new RegExp(`'${tf}'`))
    }
    // Still keeps the classic eight
    for (const tf of ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']) {
      expect(src).toMatch(new RegExp(`'${tf}'`))
    }
  })
})
