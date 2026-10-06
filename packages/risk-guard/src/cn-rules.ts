/**
 * A-share (CN Market) trading rules, price limit boundaries, T+1 settlement checks,
 * and transaction cost/tax calculators.
 *
 * Designed as pure, deterministic functions without external network or runtime dependencies,
 * enabling rigorous isolated unit testing and fail-closed safety auditing.
 * @module @dsh-trading/risk-guard
 */

export type CnBoardType = 'main' | 'chi_next' | 'star' | 'bse'

export interface PriceLimitResult {
  valid: boolean
  board: CnBoardType
  limitRatio: number
  limitUp: number
  limitDown: number
  reason?: string
}

export interface TPlusOneCheckResult {
  valid: boolean
  availableShares: number
  totalShares: number
  lockedShares: number
  requestedShares: number
  reason?: string
}

export interface LotSizeCheckResult {
  valid: boolean
  reason?: string
}

export interface CnCostBreakdown {
  side: 'buy' | 'sell'
  shares: number
  price: number
  grossAmount: number
  stampDuty: number
  transferFee: number
  commission: number
  totalFees: number
  settlementAmount: number
  effectiveRatePct: number
}

/**
 * Identify the A-share market board by symbol / ticker code.
 * - 60xxxx, 00xxxx: Main board (沪深主板)
 * - 30xxxx: ChiNext (创业板)
 * - 688xxx: STAR Market (科创板)
 * - 8xxxxx, 4xxxxx, 92xxxx: Beijing Stock Exchange (北交所)
 */
export function detectBoard(symbol: string): CnBoardType {
  const code = symbol.replace(/^[a-zA-Z]+/, '').trim()
  if (code.startsWith('688')) return 'star'
  if (code.startsWith('30')) return 'chi_next'
  if (code.startsWith('8') || code.startsWith('4') || code.startsWith('92')) return 'bse'
  return 'main'
}

/**
 * Determine the statutory daily price fluctuation limit ratio.
 * - Main board: ±10% (ST / *ST: ±5%)
 * - ChiNext & STAR: ±20%
 * - BSE (北交所): ±30%
 */
export function getPriceLimitRatio(symbol: string, isST = false): number {
  if (isST) return 0.05
  const board = detectBoard(symbol)
  switch (board) {
    case 'star':
    case 'chi_next':
      return 0.2
    case 'bse':
      return 0.3
    case 'main':
    default:
      return 0.1
  }
}

/**
 * Calculate statutory limit up and limit down prices from previous closing price.
 * Standard A-share rounding convention: rounded to nearest 0.01 CNY.
 */
export function calculatePriceLimits(prevClose: number, ratio: number): { limitUp: number; limitDown: number } {
  if (!Number.isFinite(prevClose) || prevClose <= 0) {
    throw new Error(`Invalid previous close price: ${prevClose}`)
  }
  // Use epsilon adjustment to prevent IEEE 754 precision artifacts (e.g. 19.474999999999998 -> 19.475)
  const rawUp = prevClose * (1 + ratio)
  const rawDown = prevClose * (1 - ratio)
  const limitUp = Math.round((rawUp + 1e-8) * 100) / 100
  const limitDown = Math.round((rawDown + 1e-8) * 100) / 100
  return { limitUp, limitDown }
}

/**
 * Validate order price against daily price limits (涨跌停板拦截).
 * Refuses buy orders priced above limit up, and sell orders priced below limit down.
 */
export function validatePriceLimit(order: {
  symbol: string
  price: number
  side: 'buy' | 'sell'
  prevClose: number
  isST?: boolean
}): PriceLimitResult {
  const { symbol, price, side, prevClose, isST = false } = order
  const board = detectBoard(symbol)
  const limitRatio = getPriceLimitRatio(symbol, isST)
  const { limitUp, limitDown } = calculatePriceLimits(prevClose, limitRatio)

  if (price > limitUp) {
    return {
      valid: false,
      board,
      limitRatio,
      limitUp,
      limitDown,
      reason: `委托价 ${price.toFixed(2)} 超出上限 (涨停价 ${limitUp.toFixed(2)}，涨幅上限 ${(limitRatio * 100).toFixed(0)}%)，禁止追高买入/越界委托`,
    }
  }

  if (price < limitDown) {
    return {
      valid: false,
      board,
      limitRatio,
      limitUp,
      limitDown,
      reason: `委托价 ${price.toFixed(2)} 低于下限 (跌停价 ${limitDown.toFixed(2)}，跌幅下限 ${(limitRatio * 100).toFixed(0)}%)，禁止割肉卖出/越界委托`,
    }
  }

  return { valid: true, board, limitRatio, limitUp, limitDown }
}

/**
 * Validate order against A-share T+1 settlement and position locking rules.
 * Shares bought on the current trading day cannot be sold on the same day.
 */
export function validateTPlusOne(
  position: { totalShares: number; todayBoughtShares: number },
  sellShares: number,
): TPlusOneCheckResult {
  const { totalShares, todayBoughtShares } = position
  const lockedShares = Math.max(0, todayBoughtShares)
  const availableShares = Math.max(0, totalShares - lockedShares)

  if (sellShares <= 0) {
    return {
      valid: false,
      availableShares,
      totalShares,
      lockedShares,
      requestedShares: sellShares,
      reason: `卖出股数必须大于 0，实际请求: ${sellShares}`,
    }
  }

  if (sellShares > availableShares) {
    return {
      valid: false,
      availableShares,
      totalShares,
      lockedShares,
      requestedShares: sellShares,
      reason: `触发 A 股 T+1 交易限制：当日买入的 ${lockedShares} 股不可在当日卖出。当前总持仓 ${totalShares} 股，可卖份额仅 ${availableShares} 股，申请卖出 ${sellShares} 股`,
    }
  }

  return {
    valid: true,
    availableShares,
    totalShares,
    lockedShares,
    requestedShares: sellShares,
  }
}

/**
 * Validate order lot size (手/股数完整度校验).
 * - 买入: 主板/创业板必须为 100 股的整数倍 (1手 = 100股); 科创板单笔买入最低 200 股 (递增步长 1 股)
 * - 卖出: 允许卖出不足 100 股的零股，但必须一次性全部卖出
 */
export function validateLotSize(params: {
  symbol: string
  shares: number
  side: 'buy' | 'sell'
  totalPosition?: number
}): LotSizeCheckResult {
  const { symbol, shares, side, totalPosition } = params
  const board = detectBoard(symbol)

  if (!Number.isInteger(shares) || shares <= 0) {
    return { valid: false, reason: `委托股数必须为正整数，实际为: ${shares}` }
  }

  if (side === 'buy') {
    if (board === 'star') {
      if (shares < 200) {
        return { valid: false, reason: `科创板买入委托单笔不得低于 200 股，实际申请: ${shares} 股` }
      }
    } else {
      if (shares % 100 !== 0) {
        return { valid: false, reason: `A 股普通买入必须为 100 股 (1 手) 的整数倍，实际申请: ${shares} 股` }
      }
    }
  } else {
    // 卖出校验
    if (shares % 100 !== 0) {
      if (totalPosition !== undefined && shares !== totalPosition) {
        return {
          valid: false,
          reason: `零股卖出限制：持仓不足 100 股的零碎股票必须一次性全部申报卖出 (当前总持仓: ${totalPosition} 股，申请: ${shares} 股)`,
        }
      }
    }
  }

  return { valid: true }
}

/**
 * Statutory and standard A-share fee rates:
 * - 印花税 (Stamp Duty): 仅卖出单边收取 0.05% (千分之0.5，2023年8月27日起实施减半征收)
 * - 过户费 (Transfer Fee): 沪深交易所双向收取 0.001% (十万分之一)
 * - 佣金 (Commission): 双向收取，市场标准常见万分之 2.5 (0.025%)，单笔最低 5 元
 */
export const CN_DEFAULT_FEE_RATES = {
  commissionRate: 0.00025, // 万2.5
  minCommission: 5.0, // 最低 5 元
  stampDutyRate: 0.0005, // 印花税 0.05% (卖出单边)
  transferFeeRate: 0.00001, // 过户费 0.001% (双向)
} as const

/**
 * Calculate comprehensive transaction costs, statutory taxes, and settlement cash flow for A-share trades.
 */
export function calculateCnCost(params: {
  side: 'buy' | 'sell'
  shares: number
  price: number
  commissionRate?: number
  minCommission?: number
  stampDutyRate?: number
  transferFeeRate?: number
}): CnCostBreakdown {
  const {
    side,
    shares,
    price,
    commissionRate = CN_DEFAULT_FEE_RATES.commissionRate,
    minCommission = CN_DEFAULT_FEE_RATES.minCommission,
    stampDutyRate = CN_DEFAULT_FEE_RATES.stampDutyRate,
    transferFeeRate = CN_DEFAULT_FEE_RATES.transferFeeRate,
  } = params

  const grossAmount = Math.round(shares * price * 100) / 100

  // 1. 印花税: 仅卖出征收，四舍五入到分
  const stampDuty = side === 'sell' ? Math.round(grossAmount * stampDutyRate * 100) / 100 : 0

  // 2. 过户费: 双向收取，四舍五入到分
  const transferFee = Math.round(grossAmount * transferFeeRate * 100) / 100

  // 3. 券商佣金: 双向收取，设有最低收费门槛
  const rawCommission = Math.round(grossAmount * commissionRate * 100) / 100
  const commission = Math.max(minCommission, rawCommission)

  const totalFees = Math.round((stampDuty + transferFee + commission) * 100) / 100

  // 买入需多付费用，卖出需扣减费用
  const settlementAmount = side === 'buy' ? Math.round((grossAmount + totalFees) * 100) / 100 : Math.round((grossAmount - totalFees) * 100) / 100

  const effectiveRatePct = grossAmount > 0 ? Math.round((totalFees / grossAmount) * 10000) / 100 : 0

  return {
    side,
    shares,
    price,
    grossAmount,
    stampDuty,
    transferFee,
    commission,
    totalFees,
    settlementAmount,
    effectiveRatePct,
  }
}
