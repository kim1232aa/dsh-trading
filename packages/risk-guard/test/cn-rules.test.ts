import { describe, expect, it } from 'vitest'
import {
  CN_DEFAULT_FEE_RATES,
  calculateCnCost,
  calculatePriceLimits,
  detectBoard,
  getPriceLimitRatio,
  validateLotSize,
  validatePriceLimit,
  validateTPlusOne,
} from '../src/cn-rules.js'

describe('detectBoard and getPriceLimitRatio', () => {
  it('identifies market boards correctly', () => {
    expect(detectBoard('600519')).toBe('main')
    expect(detectBoard('sh600519')).toBe('main')
    expect(detectBoard('000001')).toBe('main')
    expect(detectBoard('sz000001')).toBe('main')
    expect(detectBoard('300750')).toBe('chi_next')
    expect(detectBoard('sz300750')).toBe('chi_next')
    expect(detectBoard('688981')).toBe('star')
    expect(detectBoard('sh688981')).toBe('star')
    expect(detectBoard('832000')).toBe('bse')
    expect(detectBoard('430002')).toBe('bse')
    expect(detectBoard('920002')).toBe('bse')
  })

  it('determines statutory price limit ratios', () => {
    expect(getPriceLimitRatio('600519')).toBe(0.1)
    expect(getPriceLimitRatio('600519', true)).toBe(0.05) // ST
    expect(getPriceLimitRatio('300750')).toBe(0.2) // ChiNext
    expect(getPriceLimitRatio('688981')).toBe(0.2) // STAR
    expect(getPriceLimitRatio('832000')).toBe(0.3) // BSE
  })
})

describe('calculatePriceLimits and validatePriceLimit', () => {
  it('calculates rounded statutory limit up and down', () => {
    const { limitUp, limitDown } = calculatePriceLimits(100.0, 0.1)
    expect(limitUp).toBe(110.0)
    expect(limitDown).toBe(90.0)

    // ST stock
    const stLimits = calculatePriceLimits(20.5, 0.05)
    expect(stLimits.limitUp).toBe(21.53) // 20.5 * 1.05 = 21.525 -> 21.53
    expect(stLimits.limitDown).toBe(19.48) // 20.5 * 0.95 = 19.475 -> 19.48
  })

  it('throws on invalid prevClose', () => {
    expect(() => calculatePriceLimits(0, 0.1)).toThrow('Invalid previous close price')
    expect(() => calculatePriceLimits(-10, 0.1)).toThrow('Invalid previous close price')
  })

  it('validates prices within limits', () => {
    const res = validatePriceLimit({
      symbol: '600519',
      price: 1850.0,
      side: 'buy',
      prevClose: 1800.0,
    })
    expect(res.valid).toBe(true)
    expect(res.limitUp).toBe(1980.0)
    expect(res.limitDown).toBe(1620.0)
  })

  it('refuses buy order exceeding limit up', () => {
    const res = validatePriceLimit({
      symbol: '600519',
      price: 1985.0,
      side: 'buy',
      prevClose: 1800.0,
    })
    expect(res.valid).toBe(false)
    expect(res.reason).toContain('超出上限 (涨停价 1980.00')
  })

  it('refuses sell order below limit down', () => {
    const res = validatePriceLimit({
      symbol: '600519',
      price: 1600.0,
      side: 'sell',
      prevClose: 1800.0,
    })
    expect(res.valid).toBe(false)
    expect(res.reason).toContain('低于下限 (跌停价 1620.00')
  })
})

describe('validateTPlusOne', () => {
  it('allows selling settled shares', () => {
    const res = validateTPlusOne({ totalShares: 1000, todayBoughtShares: 400 }, 500)
    expect(res.valid).toBe(true)
    expect(res.availableShares).toBe(600)
    expect(res.lockedShares).toBe(400)
  })

  it('refuses selling today bought shares', () => {
    const res = validateTPlusOne({ totalShares: 1000, todayBoughtShares: 400 }, 700)
    expect(res.valid).toBe(false)
    expect(res.availableShares).toBe(600)
    expect(res.reason).toContain('触发 A 股 T+1 交易限制')
    expect(res.reason).toContain('可卖份额仅 600 股，申请卖出 700 股')
  })

  it('refuses zero or negative shares', () => {
    const res = validateTPlusOne({ totalShares: 1000, todayBoughtShares: 0 }, 0)
    expect(res.valid).toBe(false)
    expect(res.reason).toContain('卖出股数必须大于 0')
  })
})

describe('validateLotSize', () => {
  it('validates standard 100 share lot buys', () => {
    expect(validateLotSize({ symbol: '600519', shares: 300, side: 'buy' }).valid).toBe(true)
    expect(validateLotSize({ symbol: '600519', shares: 150, side: 'buy' }).valid).toBe(false)
  })

  it('validates STAR market min 200 shares buy', () => {
    expect(validateLotSize({ symbol: '688981', shares: 200, side: 'buy' }).valid).toBe(true)
    expect(validateLotSize({ symbol: '688981', shares: 250, side: 'buy' }).valid).toBe(true)
    expect(validateLotSize({ symbol: '688981', shares: 100, side: 'buy' }).valid).toBe(false)
  })

  it('validates sell lot size and odd lot liquidation', () => {
    // Standard 100 multiple sell
    expect(validateLotSize({ symbol: '600519', shares: 200, side: 'sell' }).valid).toBe(true)
    // Selling remaining 65 odd shares completely -> allowed
    expect(validateLotSize({ symbol: '600519', shares: 65, side: 'sell', totalPosition: 65 }).valid).toBe(true)
    // Partial odd lot sell when holding more -> refused
    expect(validateLotSize({ symbol: '600519', shares: 65, side: 'sell', totalPosition: 165 }).valid).toBe(false)
  })
})

describe('calculateCnCost', () => {
  it('calculates buy costs without stamp duty and with min commission clamp', () => {
    // 100 shares @ 10.00 = 1000 CNY
    // stamp duty: 0
    // transfer fee: 1000 * 0.00001 = 0.01 CNY
    // commission raw: 1000 * 0.00025 = 0.25 -> clamped to minCommission 5.00 CNY
    // total fees: 5.01 CNY
    // settlement: 1000 + 5.01 = 1005.01 CNY
    const cost = calculateCnCost({ side: 'buy', shares: 100, price: 10.0 })
    expect(cost.grossAmount).toBe(1000.0)
    expect(cost.stampDuty).toBe(0.0)
    expect(cost.transferFee).toBe(0.01)
    expect(cost.commission).toBe(5.0)
    expect(cost.totalFees).toBe(5.01)
    expect(cost.settlementAmount).toBe(1005.01)
  })

  it('calculates sell costs with 0.05% stamp duty', () => {
    // 10,000 shares @ 20.00 = 200,000 CNY
    // stamp duty: 200,000 * 0.0005 = 100.00 CNY
    // transfer fee: 200,000 * 0.00001 = 2.00 CNY
    // commission: 200,000 * 0.00025 = 50.00 CNY (exceeds 5.00)
    // total fees: 152.00 CNY
    // settlement: 200,000 - 152.00 = 199,848.00 CNY
    const cost = calculateCnCost({ side: 'sell', shares: 10000, price: 20.0 })
    expect(cost.grossAmount).toBe(200000.0)
    expect(cost.stampDuty).toBe(100.0)
    expect(cost.transferFee).toBe(2.0)
    expect(cost.commission).toBe(50.0)
    expect(cost.totalFees).toBe(152.0)
    expect(cost.settlementAmount).toBe(199848.0)
  })
})
