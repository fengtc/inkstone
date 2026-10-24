import type { Env } from '../env'
import { decryptYinxiangAppCredential, encryptYinxiangAppCredential, type YinxiangAppCredential } from '../lib/crypto'

const META_KEY = 'yinxiang-app-config-v1'

export interface YinxiangAppConfig extends YinxiangAppCredential {
  environment: 'sandbox' | 'production'
  callbackUrl: string | null
  source: 'database' | 'environment'
  ownerId: string | null
}

interface StoredConfig {
  ownerId: string
  ciphertext: string
  environment: 'sandbox' | 'production'
  callbackUrl: string | null
  updatedAt: number
}

export async function loadYinxiangAppConfig(env: Env): Promise<YinxiangAppConfig | null> {
  const stored = await env.DB.prepare(`SELECT value FROM app_meta WHERE key = ?1`).bind(META_KEY).first<{ value: string }>()
  if (stored) {
    try {
      const record = JSON.parse(stored.value) as StoredConfig
      const credential = await decryptYinxiangAppCredential(env, record.ownerId, record.ciphertext)
      if (credential) return { ...credential, environment: record.environment, callbackUrl: record.callbackUrl, source: 'database', ownerId: record.ownerId }
    } catch {
      return null
    }
  }
  const consumerKey = env.YINXIANG_CONSUMER_KEY?.trim()
  const consumerSecret = env.YINXIANG_CONSUMER_SECRET?.trim()
  if (!consumerKey || !consumerSecret) return null
  return {
    consumerKey,
    consumerSecret,
    environment: env.YINXIANG_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
    callbackUrl: env.YINXIANG_CALLBACK_URL?.trim() || null,
    source: 'environment',
    ownerId: null,
  }
}

export async function saveYinxiangAppConfig(
  env: Env,
  ownerId: string,
  input: { credential: YinxiangAppCredential; environment: 'sandbox' | 'production'; callbackUrl: string | null },
): Promise<void> {
  const ciphertext = await encryptYinxiangAppCredential(env, ownerId, input.credential)
  const value: StoredConfig = { ownerId, ciphertext, environment: input.environment, callbackUrl: input.callbackUrl, updatedAt: Date.now() }
  await env.DB.prepare(`INSERT INTO app_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(META_KEY, JSON.stringify(value)).run()
}

export function validateYinxiangCallbackUrl(value: string, requestUrl: string, publicUrl?: string): string {
  const parsed = new URL(value)
  const requestOrigin = new URL(requestUrl).origin
  const configuredOrigin = publicUrl ? new URL(publicUrl).origin : requestOrigin
  const localHttp = parsed.protocol === 'http:' && /^(?:localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname)
  if (!((parsed.protocol === 'https:' || localHttp) && (parsed.origin === requestOrigin || parsed.origin === configuredOrigin))) throw new Error('The callback URL must use this Inkstone origin and HTTPS')
  if (parsed.pathname !== '/oauth/yinxiang/callback') throw new Error('The callback URL must end with /oauth/yinxiang/callback')
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

export function maskConsumerKey(value: string): string {
  if (value.length <= 6) return '******'
  return `${value.slice(0, 3)}******${value.slice(-3)}`
}
