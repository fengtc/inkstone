import { describe, expect, it } from 'vitest'
import { ThriftReader, ThriftWriter, thriftTypes } from './thrift'

describe('Yinxiang Thrift binary protocol', () => {
  it('encodes a call and decodes a successful struct response', () => {
    const request = new ThriftWriter()
    request.message('getSyncState')
    request.struct()
    request.field(thriftTypes.TYPE_STRING, 1)
    request.string('token')
    request.stop()
    const requestBytes = request.result()
    expect(new DataView(requestBytes.buffer).getInt32(0)).toBe(-2147418111)

    const response = new ThriftWriter()
    response.message('getSyncState')
    response.struct()
    response.field(thriftTypes.TYPE_STRUCT, 0)
    response.struct()
    response.field(thriftTypes.TYPE_I32, 1)
    response.i32(12)
    response.stop()
    response.stop()
    const reader = new ThriftReader(response.result())
    expect(reader.message().name).toBe('getSyncState')
    const result = reader.struct()
    const state = result.fields.get(0)
    expect(state && typeof state === 'object' && 'fields' in state ? state.fields.get(1) : null).toBe(12)
  })
})
