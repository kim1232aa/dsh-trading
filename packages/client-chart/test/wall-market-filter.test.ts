import { describe, expect, it } from 'vitest'
import { filterWallsByMarket, isSpotWallMarket } from '../src/client/market-client.js'

const wall = (id: string, market?: string) => ({ id, market })

describe('large-wall market filter', () => {
  const walls = [
    wall('perp', 'perp'),
    wall('spot', 'spot'),
    wall('raw10', '10'),
    wall('upper', 'SPOT'),
    wall('missing'),
  ]

  it('treats spot, SPOT and raw type 10 as spot; missing and perp as contracts', () => {
    expect(isSpotWallMarket('spot')).toBe(true)
    expect(isSpotWallMarket('SPOT')).toBe(true)
    expect(isSpotWallMarket('10')).toBe(true)
    expect(isSpotWallMarket('perp')).toBe(false)
    expect(isSpotWallMarket(undefined)).toBe(false)
  })

  it('现货 keeps only spot books, in order', () => {
    expect(filterWallsByMarket(walls, 'spot').map(w => w.id)).toEqual(['spot', 'raw10', 'upper'])
  })

  it('合约 drops spot books and keeps untagged walls', () => {
    expect(filterWallsByMarket(walls, 'perp').map(w => w.id)).toEqual(['perp', 'missing'])
  })

  it('全部 keeps every wall', () => {
    expect(filterWallsByMarket(walls, 'all')).toHaveLength(5)
  })
})
