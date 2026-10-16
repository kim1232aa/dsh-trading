import { describe, expect, it } from 'vitest'
import { createCipheriv } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { decryptCapiBody, deriveKey0 } from '../src/decrypt.js'
import { flattenWalls } from '../src/client.js'

function aesEcbEncrypt(plain: Buffer, keyUtf8: string): Buffer {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(keyUtf8, 'utf8'), null)
  cipher.setAutoPadding(true)
  return Buffer.concat([cipher.update(plain), cipher.final()])
}

describe('decryptCapiBody', () => {
  it('derives key0 for v=2 from time header', () => {
    const time = '1792094597994'
    const key0 = deriveKey0('2', 'https://capi.coinglass.com/api/largeTakerOrder', '', time)
    expect(key0).toBe(Buffer.from(time, 'utf8').toString('base64').slice(0, 16))
    expect(key0.length).toBe(16)
  })

  it('round-trips AES-ECB + gzip payload', () => {
    const url = 'https://capi.coinglass.com/api/largeTakerOrder'
    const timeHeader = '1792094597994'
    const cacheTs = '1792094597760'
    const actualKey = 'abcdefghijklmnop' // 16 chars
    const payloadObj = [
      {
        instrument: { exName: 'Binance', baseAsset: 'BTC', contractType: 'PERPETUAL' },
        list: [
          {
            id: 1,
            side: 2,
            price: 65000,
            startUsd: 1_000_000,
            currentUsd: 900_000,
            startAmount: 15,
            currentAmount: 13.8,
            volUsd: 0,
            state: 1,
            startTime: 1_700_000_000_000,
            currentTime: 1_700_000_100_000,
          },
          {
            id: 2,
            side: 1,
            price: 72000,
            startUsd: 2_000_000,
            currentUsd: 1_800_000,
            startAmount: 28,
            currentAmount: 25,
            volUsd: 0,
            state: 1,
            startTime: 1_700_000_000_000,
            currentTime: 1_700_000_100_000,
          },
        ],
      },
    ]
    const key0 = deriveKey0('2', url, cacheTs, timeHeader)
    const userToken = aesEcbEncrypt(gzipSync(Buffer.from(actualKey, 'utf8')), key0).toString('base64')
    const dataCipher = aesEcbEncrypt(gzipSync(Buffer.from(JSON.stringify(payloadObj), 'utf8')), actualKey).toString('base64')
    const body = JSON.stringify({ success: true, code: '0', data: dataCipher })
    const decoded = decryptCapiBody(body, {
      url,
      cacheTsV2: cacheTs,
      timeHeader,
      user: userToken,
      v: '2',
    })
    expect(decoded).toEqual(payloadObj)
    const walls = flattenWalls(decoded)
    expect(walls).toHaveLength(2)
    expect(walls[0]!.side).toBe('buy')
    expect(walls[1]!.side).toBe('sell')
    expect(walls[0]!.exchange).toBe('Binance')
  })

  it('rejects unsuccessful API envelopes', () => {
    expect(() => decryptCapiBody(JSON.stringify({ success: false, code: '40001', msg: 'Server Error' }), {
      url: 'https://capi.coinglass.com/api/x',
      user: 'aa',
      v: '2',
    })).toThrow(/rejected/)
  })
})
