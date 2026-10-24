import { toBase64, toBase64Url, utf8 } from '../lib/encoding'

export interface OAuth1Credentials {
  consumerKey: string
  consumerSecret: string
  token?: string
  tokenSecret?: string
}

export function oauthPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function buildOAuth1Authorization(
  method: string,
  url: string,
  credentials: OAuth1Credentials,
  extra: Record<string, string> = {},
  timestamp = Math.floor(Date.now() / 1000).toString(),
  nonce = randomNonce(),
): string {
  const parsed = new URL(url)
  const oauth: Record<string, string> = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_version: '1.0',
  }
  if (credentials.token) oauth.oauth_token = credentials.token
  const all: Array<[string, string]> = []
  for (const [key, value] of parsed.searchParams) all.push([key, value])
  for (const [key, value] of Object.entries(extra)) all.push([key, value])
  for (const [key, value] of Object.entries(oauth)) all.push([key, value])
  all.sort((a, b) => oauthPercentEncode(a[0]).localeCompare(oauthPercentEncode(b[0])) || oauthPercentEncode(a[1]).localeCompare(oauthPercentEncode(b[1])))
  const normalizedUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname || '/'}`
  const normalized = all.map(([key, value]) => `${oauthPercentEncode(key)}=${oauthPercentEncode(value)}`).join('&')
  const base = [method.toUpperCase(), oauthPercentEncode(normalizedUrl), oauthPercentEncode(normalized)].join('&')
  const key = `${oauthPercentEncode(credentials.consumerSecret)}&${oauthPercentEncode(credentials.tokenSecret ?? '')}`
  const signature = hmacSha1Base64(key, base)
  oauth.oauth_signature = signature
  const header = Object.entries(oauth)
    .filter(([key]) => key.startsWith('oauth_'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${oauthPercentEncode(key)}="${oauthPercentEncode(value)}"`)
    .join(', ')
  return `OAuth ${header}`
}

export function parseOAuthResponse(body: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(body)) result[key] = value
  return result
}

export function hmacSha1Base64(key: string, message: string): string {
  const block = 64
  let keyBytes = utf8(key)
  if (keyBytes.byteLength > block) keyBytes = sha1(keyBytes)
  const padded = new Uint8Array(block)
  padded.set(keyBytes)
  const outer = new Uint8Array(block)
  const inner = new Uint8Array(block)
  for (let index = 0; index < block; index++) {
    outer[index] = padded[index]! ^ 0x5c
    inner[index] = padded[index]! ^ 0x36
  }
  return toBase64(sha1(concat(outer, sha1(concat(inner, utf8(message))))))
}

function sha1(input: Uint8Array): Uint8Array {
  const digest = new Sha1()
  digest.update(input)
  return digest.digest()
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function randomNonce(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(18)))
}

class Sha1 {
  private h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]
  private buffer = new Uint8Array(0)
  private length = 0

  update(input: Uint8Array): void {
    this.length += input.byteLength
    const bytes = new Uint8Array(this.buffer.byteLength + input.byteLength)
    bytes.set(this.buffer)
    bytes.set(input, this.buffer.byteLength)
    let offset = 0
    while (offset + 64 <= bytes.byteLength) {
      this.block(bytes.subarray(offset, offset + 64))
      offset += 64
    }
    this.buffer = bytes.slice(offset)
  }

  digest(): Uint8Array {
    const bitLength = this.length * 8
    const paddedLength = ((this.buffer.byteLength + 9 + 63) >> 6) << 6
    const padded = new Uint8Array(paddedLength)
    padded.set(this.buffer)
    padded[this.buffer.byteLength] = 0x80
    const view = new DataView(padded.buffer)
    view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000))
    view.setUint32(padded.length - 4, bitLength >>> 0)
    for (let offset = 0; offset < padded.length; offset += 64) this.block(padded.subarray(offset, offset + 64))
    const output = new Uint8Array(20)
    const result = new DataView(output.buffer)
    this.h.forEach((value, index) => result.setUint32(index * 4, value >>> 0))
    return output
  }

  private block(chunk: Uint8Array): void {
    const words = new Uint32Array(80)
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(index * 4)
    for (let index = 16; index < 80; index++) words[index] = rol(words[index - 3]! ^ words[index - 8]! ^ words[index - 14]! ^ words[index - 16]!, 1)
    let [a, b, c, d, e] = this.h
    for (let index = 0; index < 80; index++) {
      const fn = index < 20 ? ((b & c) | (~b & d)) : index < 40 ? (b ^ c ^ d) : index < 60 ? ((b & c) | (b & d) | (c & d)) : (b ^ c ^ d)
      const constant = index < 20 ? 0x5a827999 : index < 40 ? 0x6ed9eba1 : index < 60 ? 0x8f1bbcdc : 0xca62c1d6
      const next = (rol(a, 5) + fn + e + constant + words[index]!) >>> 0
      e = d; d = c; c = rol(b, 30); b = a; a = next
    }
    this.h = [(this.h[0]! + a) >>> 0, (this.h[1]! + b) >>> 0, (this.h[2]! + c) >>> 0, (this.h[3]! + d) >>> 0, (this.h[4]! + e) >>> 0]
  }
}

function rol(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits))
}
