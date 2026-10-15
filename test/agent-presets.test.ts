import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')

describe('bundle ships trading + analyst agent presets', () => {
  const patch = readFileSync(join(root, 'bundle/trading/cordis.patch.yml'), 'utf8')

  it('declares preset-trading and preset-analyst with official ids', () => {
    expect(patch).toMatch(/id:\s*preset-trading/)
    expect(patch).toMatch(/id:\s*preset-analyst/)
    expect(patch).toMatch(/name:\s*'@deepseek-ai\/dsh-agent-preset'/)
    // config.id is what the session picker selects
    expect(patch).toMatch(/\bid:\s*trading\b/)
    expect(patch).toMatch(/\bid:\s*analyst\b/)
  })

  it('persona rows use official prefix (not text)', () => {
    // Each dsh-persona config must open with prefix:, never text:
    const personaBlocks = patch.split("name: '@deepseek-ai/dsh-persona'")
    expect(personaBlocks.length).toBeGreaterThanOrEqual(3) // split → 1 + N
    for (const block of personaBlocks.slice(1)) {
      const head = block.slice(0, 200)
      expect(head).toMatch(/config:\s*\n\s+prefix:/)
      expect(head).not.toMatch(/config:\s*\n\s+text:/)
    }
  })

  it('does not remount tool-market inside the preset plugin lists', () => {
    // Grab from first preset-trading insert through end — tool-market appears
    // earlier as a profile row, which is correct; it must not reappear under
    // either preset's plugins: list.
    const tradingIdx = patch.indexOf('id: preset-trading')
    const analystIdx = patch.indexOf('id: preset-analyst')
    expect(tradingIdx).toBeGreaterThan(-1)
    expect(analystIdx).toBeGreaterThan(-1)
    const presetRegion = patch.slice(Math.min(tradingIdx, analystIdx))
    expect(presetRegion).not.toMatch(/@dsh-trading\/tool-market/)
  })
})

describe('presets/*/agent.cordis.yml mirrors use prefix', () => {
  for (const id of ['trading', 'analyst'] as const) {
    it(`${id} agent.cordis.yml`, () => {
      const path = join(root, 'presets', id, 'agent.cordis.yml')
      expect(existsSync(path)).toBe(true)
      const body = readFileSync(path, 'utf8')
      expect(body).toMatch(/name:\s*'@deepseek-ai\/dsh-persona'/)
      expect(body).toMatch(/prefix:\s*\|/)
      expect(body).not.toMatch(/^\s+text:\s*\|/m)
    })
  }
})
