/**
 * Cordis plugin for Fail-Closed trade authority.
 * @module @dsh-trading/authority
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { AuthorityEngine } from './verifier.js'
import type { AuthorityCheckRequest, AuthorityVerdict } from './types.js'

export type * from './types.js'
export { AuthorityEngine, canonicalizePayload, signGrant, verifyGrantSignature } from './verifier.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    authority: AuthorityService
  }
}

export interface AuthorityConfig {
  grantPath?: string | undefined
  publicKeyPem?: string | undefined
}

export class AuthorityService extends Service {
  readonly engine: AuthorityEngine

  constructor(ctx: Context, config: AuthorityConfig = {}) {
    super(ctx, 'authority')
    this.engine = new AuthorityEngine({
      grantPath: config.grantPath,
      publicKey: config.publicKeyPem,
    })
  }

  async check(req: AuthorityCheckRequest): Promise<AuthorityVerdict> {
    return this.engine.checkAuthority(req)
  }
}

export const inject = ['tools'] as const

export function apply(ctx: Context, config: AuthorityConfig = {}): void {
  const service = new AuthorityService(ctx, config)
  ctx.authority = service

  ctx.tools.register(defineTool({
    name: 'check_trade_authority',
    description: 'Verify whether a proposed trade is cryptographically authorized by human owner via Ed25519 signature.',
    parameters: {
      symbol: {
        type: 'string',
        description: 'Instrument symbol to evaluate (e.g., BTCUSDT, 600519).',
      },
      notional_usd: {
        type: 'number',
        description: 'Trade position value in USD to verify against authorized risk limits.',
      },
      mode: {
        type: 'string',
        description: 'Trading mode to verify: "paper" (simulation, always allowed) or "live" (real money). Defaults to "paper".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowed: { type: 'boolean', required: true },
          mode: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          grantId: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const icon = value.allowed ? '🛡️ [AUTHORIZED]' : '🚫 [BLOCKED]'
        return [{
          type: 'text',
          text: `${icon} Mode: ${value.mode.toUpperCase()} | Allowed: ${value.allowed} | Reason: ${value.reason}`,
        }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const symbol = String(args.symbol || '').toUpperCase()
      const notional_usd = Number(args.notional_usd) || 0
      const mode = (args.mode === 'live' ? 'live' : 'paper') as 'paper' | 'live'

      const res = await service.check({
        symbol,
        notionalUSD: notional_usd,
        mode,
      })

      return {
        allowed: res.allowed,
        mode: res.mode,
        reason: res.reason,
        grantId: res.grantId ?? '',
      }
    },
  }))
}

export const Config = Schema.object({
  grantPath: Schema.string().description('Path to the Ed25519 live-trading.grant.json file.'),
  publicKeyPem: Schema.string().description('Ed25519 public key in PEM or SPKI format.'),
}) as unknown as Schema<AuthorityConfig>

export default apply
