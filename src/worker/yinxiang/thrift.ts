import { fromUtf8, utf8 } from '../lib/encoding'

const TYPE_STOP = 0
const TYPE_BOOL = 2
const TYPE_I32 = 8
const TYPE_I64 = 10
const TYPE_STRING = 11
const TYPE_STRUCT = 12
const TYPE_MAP = 13
const TYPE_LIST = 15

export interface ThriftStringValue { text: string; bytes: Uint8Array }
export type ThriftValue = null | boolean | number | string | Uint8Array | ThriftStringValue | ThriftValue[] | Map<ThriftValue, ThriftValue> | { fields: Map<number, ThriftValue> }

export class ThriftWriter {
  private readonly bytes: number[] = []
  private fieldStack: number[] = []

  message(name: string, seqid = 1): void {
    this.i32(0x80010001)
    this.string(name)
    this.i32(seqid)
  }

  struct(): void { this.fieldStack.push(0) }
  field(type: number, id: number): void { this.byte(type); this.i16(id) }
  stop(): void { this.byte(TYPE_STOP); this.fieldStack.pop() }
  string(value: string): void { const data = utf8(value); this.i32(data.byteLength); this.raw(data) }
  binary(value: Uint8Array): void { this.i32(value.byteLength); this.raw(value) }
  bool(value: boolean): void { this.byte(value ? 1 : 0) }
  i32(value: number): void { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setInt32(0, value); this.raw(bytes) }
  i64(value: number): void { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigInt64(0, BigInt(value)); this.raw(bytes) }
  list(type: number, values: Array<(writer: ThriftWriter) => void>): void { this.byte(type); this.i32(values.length); for (const write of values) write(this) }
  result(): Uint8Array { return new Uint8Array(this.bytes) }
  private byte(value: number): void { this.bytes.push(value & 0xff) }
  private i16(value: number): void { this.bytes.push((value >> 8) & 0xff, value & 0xff) }
  private raw(value: Uint8Array): void { for (const byte of value) this.bytes.push(byte) }
}

export class ThriftReader {
  private offset = 0
  constructor(private readonly bytes: Uint8Array) {}

  message(): { name: string; type: number; seqid: number } {
    const version = this.i32()
    if ((version >>> 16) !== 0x8001) throw new Error('Invalid Thrift protocol version')
    return { type: version & 0xff, name: this.string(), seqid: this.i32() }
  }

  struct(): { fields: Map<number, ThriftValue> } {
    const fields = new Map<number, ThriftValue>()
    while (true) {
      const type = this.byte()
      if (type === TYPE_STOP) break
      const id = this.i16()
      fields.set(id, this.value(type))
    }
    return { fields }
  }

  value(type: number): ThriftValue {
    switch (type) {
      case TYPE_BOOL: return this.byte() !== 0
      case TYPE_I32: return this.i32()
      case TYPE_I64: return Number(this.i64())
      case TYPE_STRING: {
        const bytes = this.binary()
        return { text: fromUtf8(bytes), bytes }
      }
      case 1: return this.binary()
      case TYPE_STRUCT: return this.struct()
      case TYPE_LIST: {
        const itemType = this.byte(); const length = this.i32(); const values: ThriftValue[] = []
        for (let index = 0; index < length; index++) values.push(this.value(itemType))
        return values
      }
      case TYPE_MAP: {
        const keyType = this.byte(); const valueType = this.byte(); const length = this.i32(); const values = new Map<ThriftValue, ThriftValue>()
        for (let index = 0; index < length; index++) values.set(this.value(keyType), this.value(valueType))
        return values
      }
      default: throw new Error(`Unsupported Thrift field type ${type}`)
    }
  }

  private byte(): number { if (this.offset >= this.bytes.length) throw new Error('Unexpected end of Thrift response'); return this.bytes[this.offset++]! }
  private i16(): number { return (this.byte() << 8) | this.byte() }
  private i32(): number { const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4).getInt32(0); this.offset += 4; return value }
  private i64(): bigint { const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8).getBigInt64(0); this.offset += 8; return value }
  private string(): string { const length = this.i32(); if (length < 0 || this.offset + length > this.bytes.length) throw new Error('Invalid Thrift string length'); const value = fromUtf8(this.bytes.subarray(this.offset, this.offset + length)); this.offset += length; return value }
  private binary(): Uint8Array { const length = this.i32(); if (length < 0 || this.offset + length > this.bytes.length) throw new Error('Invalid Thrift binary length'); const value = this.bytes.slice(this.offset, this.offset + length); this.offset += length; return value }
}

export const thriftTypes = { TYPE_BOOL, TYPE_I32, TYPE_I64, TYPE_STRING, TYPE_STRUCT, TYPE_MAP, TYPE_LIST }
