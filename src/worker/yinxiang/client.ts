import { buildOAuth1Authorization, parseOAuthResponse, type OAuth1Credentials } from './oauth'
import { ThriftReader, ThriftWriter, thriftTypes, type ThriftStringValue, type ThriftValue } from './thrift'

export interface YinxiangClientConfig {
  environment: 'sandbox' | 'production'
  consumerKey: string
  consumerSecret: string
  token: string
  tokenSecret: string
  noteStoreUrl: string
}

export interface YinxiangNotebookRecord {
  guid: string
  name: string
  stackName: string | null
  shared: boolean
  application: boolean
}

export interface YinxiangResourceRecord {
  guid: string
  noteGuid: string
  mime: string
  fileName: string
  size: number
  bodyHash: string | null
  data: Uint8Array | null
}

export interface YinxiangNoteRecord {
  guid: string
  title: string
  content: string
  created: number
  updated: number
  updateSequenceNum: number
  notebookGuid: string | null
  tagGuids: string[]
  resources: YinxiangResourceRecord[]
}

export interface YinxiangSyncState {
  updateCount: number
  fullSyncBefore: number
}

export interface YinxiangSyncChunk {
  chunkHighUSN: number
  updateCount: number
  notes: YinxiangNoteRecord[]
  notebooks: YinxiangNotebookRecord[]
  expungedNoteGuids: string[]
  expungedNotebookGuids: string[]
}

export class YinxiangClient {
  private readonly oauth: OAuth1Credentials

  constructor(private readonly config: YinxiangClientConfig, private readonly fetcher: typeof fetch = fetch) {
    this.oauth = {
      consumerKey: config.consumerKey,
      consumerSecret: config.consumerSecret,
      token: config.token,
      tokenSecret: config.tokenSecret,
    }
    assertNoteStoreUrl(config.noteStoreUrl, config.environment)
  }

  async getSyncState(): Promise<YinxiangSyncState> {
    const result = await this.call('getSyncState', (writer) => {
      writer.field(thriftTypes.TYPE_STRING, 1); writer.string(this.config.token)
    })
    const state = structField(result, 0)
    return { updateCount: numberField(state, 1) ?? 0, fullSyncBefore: numberField(state, 2) ?? 0 }
  }

  async getFilteredSyncChunk(afterUSN: number, maxEntries: number): Promise<YinxiangSyncChunk> {
    const result = await this.call('getFilteredSyncChunk', (writer) => {
      writer.field(thriftTypes.TYPE_STRING, 1); writer.string(this.config.token)
      writer.field(thriftTypes.TYPE_I32, 2); writer.i32(afterUSN)
      writer.field(thriftTypes.TYPE_I32, 3); writer.i32(maxEntries)
      writer.field(thriftTypes.TYPE_STRUCT, 4); writer.struct()
      for (const [id, value] of [[1, true], [2, true], [3, true], [4, true], [5, true], [6, false], [7, true], [8, true], [9, false]] as const) {
        writer.field(thriftTypes.TYPE_BOOL, id); writer.bool(value)
      }
      writer.stop()
    })
    const chunk = structField(result, 0)
    return {
      chunkHighUSN: numberField(chunk, 19) ?? afterUSN,
      updateCount: numberField(chunk, 2) ?? 0,
      notes: listField(chunk, 3).map(parseNote),
      notebooks: listField(chunk, 9).map(parseNotebook),
      expungedNoteGuids: listField(chunk, 4).map(stringValue).filter((item): item is string => item !== null),
      expungedNotebookGuids: listField(chunk, 16).map(stringValue).filter((item): item is string => item !== null),
    }
  }

  async getNote(guid: string): Promise<YinxiangNoteRecord> {
    const result = await this.call('getNote', (writer) => {
      writer.field(thriftTypes.TYPE_STRING, 1); writer.string(this.config.token)
      writer.field(thriftTypes.TYPE_STRING, 2); writer.string(guid)
      for (const id of [3, 4, 5, 6, 7, 8]) { writer.field(thriftTypes.TYPE_BOOL, id); writer.bool(true) }
    })
    return parseNote(structField(result, 0))
  }

  async getResource(guid: string): Promise<YinxiangResourceRecord> {
    const result = await this.call('getResource', (writer) => {
      writer.field(thriftTypes.TYPE_STRING, 1); writer.string(this.config.token)
      writer.field(thriftTypes.TYPE_STRING, 2); writer.string(guid)
      writer.field(thriftTypes.TYPE_BOOL, 3); writer.bool(true)
      writer.field(thriftTypes.TYPE_BOOL, 4); writer.bool(false)
      writer.field(thriftTypes.TYPE_BOOL, 5); writer.bool(false)
      writer.field(thriftTypes.TYPE_BOOL, 6); writer.bool(false)
    })
    return parseResource(structField(result, 0))
  }

  async listNotebooks(): Promise<YinxiangNotebookRecord[]> {
    const result = await this.call('listNotebooks', (writer) => {
      writer.field(thriftTypes.TYPE_STRING, 1); writer.string(this.config.token)
    })
    const value = result.fields.get(0)
    return Array.isArray(value) ? value.map(parseNotebook) : listField(structField(result, 0), 1).map(parseNotebook)
  }

  private async call(method: string, writeArgs: (writer: ThriftWriter) => void): Promise<{ fields: Map<number, ThriftValue> }> {
    const writer = new ThriftWriter()
    writer.message(method)
    writer.struct(); writeArgs(writer); writer.stop()
    const response = await this.fetcher(this.config.noteStoreUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-thrift',
        Accept: 'application/x-thrift',
        Authorization: buildOAuth1Authorization('POST', this.config.noteStoreUrl, this.oauth),
      },
      body: writer.result(),
    })
    if (response.status >= 300 && response.status < 400) throw new Error('Yinxiang NoteStore redirected unexpectedly')
    if (!response.ok) throw new Error(`Yinxiang NoteStore request failed (${response.status})`)
    const reader = new ThriftReader(new Uint8Array(await response.arrayBuffer()))
    reader.message()
    const result = reader.struct()
    const error = structField(result, 1)
    if (error) throw new Error(stringField(error, 1) ?? 'Yinxiang API returned an error')
    return result
  }
}

export function assertNoteStoreUrl(value: string, environment: 'sandbox' | 'production'): void {
  const url = new URL(value)
  const expected = environment === 'sandbox' ? 'sandbox.yinxiang.com' : 'app.yinxiang.com'
  if (url.protocol !== 'https:' || url.hostname !== expected) {
    throw new Error('The Yinxiang NoteStore URL is not trusted for this environment')
  }
}

export async function requestOAuthEndpoint(
  endpoint: string,
  credentials: OAuth1Credentials,
  extra: Record<string, string>,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, string>> {
  const url = new URL(endpoint)
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value)
  const response = await fetcher(url, {
    method: 'GET', redirect: 'manual', headers: { Authorization: buildOAuth1Authorization('GET', url.toString(), credentials) },
  })
  if (response.status >= 300 && response.status < 400) throw new Error('Yinxiang OAuth endpoint redirected unexpectedly')
  if (!response.ok) throw new Error(`Yinxiang OAuth request failed (${response.status})`)
  return parseOAuthResponse(await response.text())
}

export function oauthEndpoint(environment: 'sandbox' | 'production'): string {
  return `https://${environment === 'sandbox' ? 'sandbox' : 'app'}.yinxiang.com/oauth`
}

export function authorizeEndpoint(environment: 'sandbox' | 'production'): string {
  return `https://${environment === 'sandbox' ? 'sandbox' : 'app'}.yinxiang.com/OAuth.action`
}

function parseNote(value: ThriftValue): YinxiangNoteRecord {
  const fields = asFields(value)
  return {
    guid: stringField(fields, 1) ?? '', title: stringField(fields, 2) ?? '', content: stringField(fields, 3) ?? '',
    created: numberField(fields, 6) ?? 0, updated: numberField(fields, 7) ?? 0, updateSequenceNum: numberField(fields, 10) ?? 0,
    notebookGuid: stringField(fields, 11), tagGuids: listField(fields, 12).map(stringValue).filter((item): item is string => item !== null), resources: listField(fields, 13).map(parseResource),
  }
}

function parseResource(value: ThriftValue): YinxiangResourceRecord {
  const fields = asFields(value)
  const data = asFields(fields.get(3))
  const bodyHash = binaryField(data, 1)
  return { guid: stringField(fields, 1) ?? '', noteGuid: stringField(fields, 2) ?? '', mime: stringField(fields, 4) ?? 'application/octet-stream', fileName: stringField(asFields(fields.get(10)), 9) ?? 'attachment', size: numberField(data, 2) ?? 0, bodyHash: bodyHash ? hex(bodyHash) : null, data: binaryField(data, 3) }
}

function parseNotebook(value: ThriftValue): YinxiangNotebookRecord {
  const fields = asFields(value)
  return { guid: stringField(fields, 1) ?? '', name: stringField(fields, 2) ?? '', stackName: stringField(fields, 3), shared: Boolean(valueField(fields, 9)), application: Boolean(valueField(fields, 10)) }
}

function asFields(value: ThriftValue | undefined): Map<number, ThriftValue> { return value && typeof value === 'object' && 'fields' in value ? value.fields : new Map() }
function structField(value: { fields: Map<number, ThriftValue> }, id: number): { fields: Map<number, ThriftValue> } { return asFields(value.fields.get(id)) as unknown as { fields: Map<number, ThriftValue> } }
function stringField(value: Map<number, ThriftValue> | { fields: Map<number, ThriftValue> }, id: number): string | null { const item = value instanceof Map ? value.get(id) : value.fields.get(id); return typeof item === 'string' ? item : isThriftString(item) ? item.text : null }
function numberField(value: Map<number, ThriftValue> | { fields: Map<number, ThriftValue> }, id: number): number | null { const item = value instanceof Map ? value.get(id) : value.fields.get(id); return typeof item === 'number' ? item : null }
function valueField(value: Map<number, ThriftValue>, id: number): ThriftValue | null { return value.get(id) ?? null }
function listField(value: Map<number, ThriftValue> | { fields: Map<number, ThriftValue> }, id: number): ThriftValue[] { const item = value instanceof Map ? value.get(id) : value.fields.get(id); return Array.isArray(item) ? item : [] }
function binaryField(value: Map<number, ThriftValue>, id: number): Uint8Array | null { const item = value.get(id); return item instanceof Uint8Array ? item : isThriftString(item) ? item.bytes : null }
function isThriftString(value: ThriftValue | undefined): value is ThriftStringValue { return Boolean(value && typeof value === 'object' && 'text' in value && 'bytes' in value) }
function stringValue(value: ThriftValue): string | null { return typeof value === 'string' ? value : isThriftString(value) ? value.text : null }
function hex(bytes: Uint8Array): string { return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('') }
