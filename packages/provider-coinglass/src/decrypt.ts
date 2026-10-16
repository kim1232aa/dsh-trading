/**
 * CoinGlass capi response decrypt (AES-128-ECB + gzip), matching the website
 * frontend scheme. Private / unstable — CoinGlass may rotate keys or headers.
 * @module
 */
import { createDecipheriv } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

const KEY_TABLE: Record<string, string> = {
  '55': '170b070da9654622',
  '66': 'd6537d845a964081',
  '77': '863f08689c97435b',
}

export interface DecryptContext {
  /** Full request URL (path used when v=1). */
  url: string
  /** Request header cache-ts-v2 (ms string). */
  cacheTsV2?: string
  /** Response header `time`. */
  timeHeader?: string
  /** Response header `user` (base64 token). */
  user: string
  /** Response header `v` (key derivation version). */
  v: string
}

/** Derive the 16-char outer AES key from header version `v`. */
export function deriveKey0(v: string, url: string, cacheTs = '', timeHeader = ''): string {
  let constant: string
  if (v === '0') constant = cacheTs
  else if (v === '1') {
    try {
      constant = new URL(url).pathname
    } catch {
      constant = url
    }
  } else if (v === '2') constant = timeHeader
  else {
    const legacy = KEY_TABLE[v]
    if (!legacy) throw new Error(`unsupported coinglass decrypt version v=${v}`)
    constant = legacy
  }
  return Buffer.from(constant, 'utf8').toString('base64').slice(0, 16)
}

function aesEcbDecrypt(payload: Buffer, keyUtf8: string): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(keyUtf8, 'utf8'), null)
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(payload), decipher.final()])
}

/**
 * Decrypt an encrypted capi JSON body.
 * Returns the parsed `data` payload (usually an array of venue groups).
 */
export function decryptCapiBody(bodyText: string, ctx: DecryptContext): unknown {
  const outer = JSON.parse(bodyText) as {
    success?: boolean
    code?: string | number
    data?: unknown
    msg?: string
  }
  const code = outer.code
  if (outer.success === false || (code !== undefined && String(code) !== '0' && String(code) !== '200')) {
    throw new Error(`coinglass API rejected: ${outer.msg ?? JSON.stringify(outer)}`)
  }
  const data = outer.data
  if (typeof data !== 'string' || data.length === 0) return outer

  const payload = Buffer.from(data, 'base64')
  const token = Buffer.from(ctx.user, 'base64')
  const key0 = deriveKey0(String(ctx.v), ctx.url, ctx.cacheTsV2 ?? '', ctx.timeHeader ?? '')
  const step1 = aesEcbDecrypt(token, key0)
  const actualKey = gunzipSync(step1).toString('utf8')
  const step2 = aesEcbDecrypt(payload, actualKey)
  return JSON.parse(gunzipSync(step2).toString('utf8'))
}
