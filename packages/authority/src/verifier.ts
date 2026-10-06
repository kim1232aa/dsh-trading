/**
 * Ed25519 cryptographic verifier and Fail-Closed authority engine.
 * @module @dsh-trading/authority
 */

import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { AuthorityCheckRequest, AuthorityVerdict, TradingGrantFile, TradingGrantPayload } from './types.js'

/**
 * Produces deterministic, canonically-sorted JSON representation for signing.
 */
export function canonicalizePayload(payload: TradingGrantPayload): string {
  const sorted: Record<string, unknown> = {}
  const raw = payload as unknown as Record<string, unknown>
  for (const key of Object.keys(payload).sort()) {
    const val = raw[key]
    if (Array.isArray(val)) {
      sorted[key] = [...val].sort()
    } else {
      sorted[key] = val
    }
  }
  return JSON.stringify(sorted)
}

/**
 * Signs a trading grant with an Ed25519 private key.
 */
export function signGrant(
  payload: TradingGrantPayload,
  privateKey: crypto.KeyLike | string,
): TradingGrantFile {
  const canonical = canonicalizePayload(payload)
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf-8'), privateKey)
  return {
    payload,
    signature: signature.toString('hex'),
  }
}

/**
 * Verifies an Ed25519 signature against the canonical grant payload.
 */
export function verifyGrantSignature(
  grantFile: TradingGrantFile,
  publicKey: crypto.KeyLike | string,
): boolean {
  try {
    const canonical = canonicalizePayload(grantFile.payload)
    const sigBuffer = Buffer.from(grantFile.signature, 'hex')
    return crypto.verify(null, Buffer.from(canonical, 'utf-8'), publicKey, sigBuffer)
  } catch {
    return false
  }
}

export interface AuthorityEngineOptions {
  grantPath?: string | undefined
  publicKey?: crypto.KeyLike | string | undefined
}

export class AuthorityEngine {
  readonly grantPath: string
  readonly publicKey: crypto.KeyLike | string | undefined

  constructor(options: AuthorityEngineOptions = {}) {
    this.grantPath = options.grantPath || './data/live-trading.grant.json'
    this.publicKey = options.publicKey
  }

  /**
   * Evaluates trade authorization using Fail-Closed invariants.
   */
  async checkAuthority(req: AuthorityCheckRequest): Promise<AuthorityVerdict> {
    const requestedMode = req.mode ?? 'paper'

    // Paper mode is safe and always permitted by default
    if (requestedMode === 'paper') {
      return {
        allowed: true,
        mode: 'paper',
        reason: '模拟盘交易模式默认放行 (Dry-run paper mode allowed)',
      }
    }

    // For live trading: Fail-Closed enforcement
    if (!this.publicKey) {
      return {
        allowed: false,
        mode: 'blocked',
        reason: '系统未配置 Ed25519 权威公钥，实盘交易严格熔断 (Fail-Closed: No authority public key configured)',
      }
    }

    let grantFile: TradingGrantFile
    try {
      const raw = await readFile(this.grantPath, 'utf-8')
      grantFile = JSON.parse(raw) as TradingGrantFile
    } catch {
      return {
        allowed: false,
        mode: 'blocked',
        reason: `未找到实盘授权文件 (${this.grantPath})，系统处于 Fail-Closed 安全熔断状态`,
      }
    }

    // 1. Signature check
    const isSignatureValid = verifyGrantSignature(grantFile, this.publicKey)
    if (!isSignatureValid) {
      return {
        allowed: false,
        mode: 'blocked',
        reason: '实盘授权证书 Ed25519 签名不匹配或内容已被篡改，拒绝执行实盘交易',
      }
    }

    const { payload } = grantFile

    // 2. Grant mode check
    if (payload.mode !== 'live') {
      return {
        allowed: false,
        mode: 'blocked',
        reason: '授权证书模式非 live 实盘模式',
      }
    }

    // 3. Expiration check
    const nowMs = Date.now()
    const validUntilMs = Date.parse(payload.validUntil)
    if (isNaN(validUntilMs) || nowMs > validUntilMs) {
      return {
        allowed: false,
        mode: 'blocked',
        reason: `实盘授权已过期 (有效期至: ${payload.validUntil})`,
      }
    }

    // 4. Symbol whitelisting
    const targetSymbol = req.symbol.toUpperCase()
    const isAllowedSymbol = payload.allowedSymbols.includes('*') ||
      payload.allowedSymbols.some(s => s.toUpperCase() === targetSymbol)

    if (!isAllowedSymbol) {
      return {
        allowed: false,
        mode: 'blocked',
        reason: `品种 ${req.symbol} 未包含在实盘白名单中: [${payload.allowedSymbols.join(', ')}]`,
      }
    }

    // 5. Position limit check
    if (req.notionalUSD > payload.maxPositionUSD) {
      return {
        allowed: false,
        mode: 'blocked',
        reason: `交易规模 $${req.notionalUSD.toFixed(2)} 超过单笔授权限额 $${payload.maxPositionUSD.toFixed(2)}`,
      }
    }

    // All cryptographic and operational gates passed
    return {
      allowed: true,
      mode: 'live',
      reason: 'Ed25519 签名验证通过，处于有效授权期及风控限额内',
      grantId: payload.grantId,
    }
  }
}
