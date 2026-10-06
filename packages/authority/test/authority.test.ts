import crypto from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuthorityEngine, signGrant } from '../src/verifier.js'
import type { TradingGrantPayload } from '../src/types.js'

describe('AuthorityEngine (Fail-Closed Cryptographic Authority)', () => {
  let tempDir: string
  let grantPath: string
  let keyPair: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-authority-test-'))
    grantPath = join(tempDir, 'live-trading.grant.json')
    keyPair = crypto.generateKeyPairSync('ed25519')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('allows paper trading mode by default without any grant file', async () => {
    const engine = new AuthorityEngine({ grantPath })
    const verdict = await engine.checkAuthority({
      symbol: 'BTCUSDT',
      notionalUSD: 50000,
      mode: 'paper',
    })

    expect(verdict.allowed).toBe(true)
    expect(verdict.mode).toBe('paper')
  })

  it('fails closed when live mode is requested but no authority public key is configured', async () => {
    const engine = new AuthorityEngine({ grantPath, publicKey: undefined })
    const verdict = await engine.checkAuthority({
      symbol: 'BTCUSDT',
      notionalUSD: 1000,
      mode: 'live',
    })

    expect(verdict.allowed).toBe(false)
    expect(verdict.mode).toBe('blocked')
    expect(verdict.reason).toContain('未配置 Ed25519 权威公钥')
  })

  it('fails closed when live mode is requested but grant file is missing', async () => {
    const engine = new AuthorityEngine({ grantPath, publicKey: keyPair.publicKey })
    const verdict = await engine.checkAuthority({
      symbol: 'BTCUSDT',
      notionalUSD: 1000,
      mode: 'live',
    })

    expect(verdict.allowed).toBe(false)
    expect(verdict.mode).toBe('blocked')
    expect(verdict.reason).toContain('未找到实盘授权文件')
  })

  it('passes live trade verification when valid Ed25519 signed grant exists', async () => {
    const payload: TradingGrantPayload = {
      grantId: 'grant-2026-001',
      issuedAt: new Date(Date.now() - 60000).toISOString(),
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      allowedSymbols: ['BTCUSDT', 'ETHUSDT'],
      maxPositionUSD: 10000,
      mode: 'live',
    }

    const grantFile = signGrant(payload, keyPair.privateKey)
    await writeFile(grantPath, JSON.stringify(grantFile, null, 2), 'utf-8')

    const engine = new AuthorityEngine({ grantPath, publicKey: keyPair.publicKey })
    const verdict = await engine.checkAuthority({
      symbol: 'ETHUSDT',
      notionalUSD: 2500,
      mode: 'live',
    })

    expect(verdict.allowed).toBe(true)
    expect(verdict.mode).toBe('live')
    expect(verdict.grantId).toBe('grant-2026-001')
  })

  it('fails closed when grant signature does not match (tampered payload)', async () => {
    const payload: TradingGrantPayload = {
      grantId: 'grant-tampered',
      issuedAt: new Date(Date.now() - 60000).toISOString(),
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      allowedSymbols: ['BTCUSDT'],
      maxPositionUSD: 500,
      mode: 'live',
    }

    const grantFile = signGrant(payload, keyPair.privateKey)
    // Tamper with payload after signing
    grantFile.payload.maxPositionUSD = 1000000

    await writeFile(grantPath, JSON.stringify(grantFile, null, 2), 'utf-8')

    const engine = new AuthorityEngine({ grantPath, publicKey: keyPair.publicKey })
    const verdict = await engine.checkAuthority({
      symbol: 'BTCUSDT',
      notionalUSD: 1000,
      mode: 'live',
    })

    expect(verdict.allowed).toBe(false)
    expect(verdict.mode).toBe('blocked')
    expect(verdict.reason).toContain('签名不匹配或内容已被篡改')
  })

  it('fails closed when grant is expired', async () => {
    const payload: TradingGrantPayload = {
      grantId: 'grant-expired',
      issuedAt: new Date(Date.now() - 7200000).toISOString(),
      validUntil: new Date(Date.now() - 3600000).toISOString(), // expired 1h ago
      allowedSymbols: ['*'],
      maxPositionUSD: 50000,
      mode: 'live',
    }

    const grantFile = signGrant(payload, keyPair.privateKey)
    await writeFile(grantPath, JSON.stringify(grantFile, null, 2), 'utf-8')

    const engine = new AuthorityEngine({ grantPath, publicKey: keyPair.publicKey })
    const verdict = await engine.checkAuthority({
      symbol: 'BTCUSDT',
      notionalUSD: 1000,
      mode: 'live',
    })

    expect(verdict.allowed).toBe(false)
    expect(verdict.mode).toBe('blocked')
    expect(verdict.reason).toContain('实盘授权已过期')
  })

  it('fails closed when trading symbol is not in whitelist', async () => {
    const payload: TradingGrantPayload = {
      grantId: 'grant-whitelist',
      issuedAt: new Date(Date.now() - 60000).toISOString(),
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      allowedSymbols: ['BTCUSDT'],
      maxPositionUSD: 50000,
      mode: 'live',
    }

    const grantFile = signGrant(payload, keyPair.privateKey)
    await writeFile(grantPath, JSON.stringify(grantFile, null, 2), 'utf-8')

    const engine = new AuthorityEngine({ grantPath, publicKey: keyPair.publicKey })
    const verdict = await engine.checkAuthority({
      symbol: 'SOLUSDT', // not whitelisted
      notionalUSD: 1000,
      mode: 'live',
    })

    expect(verdict.allowed).toBe(false)
    expect(verdict.mode).toBe('blocked')
    expect(verdict.reason).toContain('未包含在实盘白名单中')
  })

  it('fails closed when trade value exceeds authorized position cap', async () => {
    const payload: TradingGrantPayload = {
      grantId: 'grant-cap',
      issuedAt: new Date(Date.now() - 60000).toISOString(),
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      allowedSymbols: ['*'],
      maxPositionUSD: 5000,
      mode: 'live',
    }

    const grantFile = signGrant(payload, keyPair.privateKey)
    await writeFile(grantPath, JSON.stringify(grantFile, null, 2), 'utf-8')

    const engine = new AuthorityEngine({ grantPath, publicKey: keyPair.publicKey })
    const verdict = await engine.checkAuthority({
      symbol: 'BTCUSDT',
      notionalUSD: 10000, // exceeds $5000 limit
      mode: 'live',
    })

    expect(verdict.allowed).toBe(false)
    expect(verdict.mode).toBe('blocked')
    expect(verdict.reason).toContain('超过单笔授权限额')
  })
})
