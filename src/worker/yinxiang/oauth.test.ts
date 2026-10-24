import { describe, expect, it } from 'vitest'
import { buildOAuth1Authorization, hmacSha1Base64, oauthPercentEncode, parseOAuthResponse } from './oauth'
import { assertNoteStoreUrl } from './client'

describe('Yinxiang OAuth 1.0 helpers', () => {
  it('uses RFC 5849 percent encoding and HMAC-SHA1', () => {
    expect(oauthPercentEncode('Ladies + Gentlemen')).toBe('Ladies%20%2B%20Gentlemen')
    expect(hmacSha1Base64('key', 'The quick brown fox jumps over the lazy dog')).toBe('3nybhbi3iqa8ino29wqQcBydtNk=')
  })

  it('builds a deterministic authorization header for fixed nonce and timestamp', () => {
    const header = buildOAuth1Authorization('GET', 'https://sandbox.yinxiang.com/oauth?oauth_callback=https%3A%2F%2Fexample.test%2Fcallback', { consumerKey: 'key', consumerSecret: 'secret' }, {}, '1436532000', 'nonce')
    expect(header).toContain('oauth_signature=')
    expect(header).toContain('oauth_nonce="nonce"')
    expect(header).not.toContain('tokenSecret')
  })

  it('parses OAuth response fields without logging or transforming secrets', () => {
    expect(parseOAuthResponse('oauth_token=t%2B1&oauth_token_secret=&edam_userId=42')).toEqual({ oauth_token: 't+1', oauth_token_secret: '', edam_userId: '42' })
  })

  it('rejects international Evernote and non-HTTPS NoteStore URLs', () => {
    expect(() => assertNoteStoreUrl('https://www.evernote.com/shard/s1/notestore', 'production')).toThrow()
    expect(() => assertNoteStoreUrl('https://evil.app.yinxiang.com/shard/s1/notestore', 'production')).toThrow()
    expect(() => assertNoteStoreUrl('http://app.yinxiang.com/shard/s1/notestore', 'production')).toThrow()
    expect(() => assertNoteStoreUrl('https://app.yinxiang.com/shard/s1/notestore', 'production')).not.toThrow()
  })
})
