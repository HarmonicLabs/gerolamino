import { BigDecimal, Effect } from "effect";
import { CborEncodeError, CborKinds, type CborSchemaType } from "./schema";

const textEncoder = new TextEncoder();

class CborWriter {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }

  private grow(needed: number): void {
    const required = this.len + needed;
    if (required <= this.buf.length) return;
    let newCap = this.buf.length;
    while (newCap < required) newCap *= 2;
    const newBuf = new Uint8Array(newCap);
    newBuf.set(this.buf.subarray(0, this.len));
    this.buf = newBuf;
    this.view = new DataView(this.buf.buffer);
  }

  writeByte(b: number): void {
    this.grow(1);
    this.buf[this.len++] = b;
  }

  writeBytes(bs: Uint8Array): void {
    this.grow(bs.length);
    this.buf.set(bs, this.len);
    this.len += bs.length;
  }

  writeUint16BE(n: number): void {
    this.grow(2);
    this.view.setUint16(this.len, n);
    this.len += 2;
  }

  writeUint32BE(n: number): void {
    this.grow(4);
    this.view.setUint32(this.len, n);
    this.len += 4;
  }

  writeBigUint64BE(n: bigint): void {
    this.grow(8);
    this.view.setBigUint64(this.len, n);
    this.len += 8;
  }

  writeFloat16BE(n: number): void {
    // Encode as float32, then extract half-precision bits
    const buf32 = new ArrayBuffer(4);
    const dv32 = new DataView(buf32);
    dv32.setFloat32(0, n);
    const bits32 = dv32.getUint32(0);

    const sign = (bits32 >> 16) & 0x8000;
    const exponent = ((bits32 >> 23) & 0xff) - 127 + 15;
    const fraction = (bits32 >> 13) & 0x03ff;

    let halfBits: number;
    if (exponent <= 0) {
      // Subnormal or zero
      if (exponent < -10) {
        halfBits = sign;
      } else {
        const frac = (fraction | 0x0400) >> (1 - exponent);
        halfBits = sign | frac;
      }
    } else if (exponent >= 31) {
      // Infinity or NaN
      halfBits = sign | 0x7c00 | (fraction ? fraction : 0);
    } else {
      halfBits = sign | (exponent << 10) | fraction;
    }

    this.grow(2);
    this.view.setUint16(this.len, halfBits);
    this.len += 2;
  }

  writeFloat32BE(n: number): void {
    this.grow(4);
    this.view.setFloat32(this.len, n);
    this.len += 4;
  }

  writeFloat64BE(n: number): void {
    this.grow(8);
    this.view.setFloat64(this.len, n);
    this.len += 8;
  }

  writeTypeAndLength(majorType: number, length: bigint, addInfos?: number): void {
    const header = majorType << CborKinds.MAJOR_TYPE_SHIFT;

    if (addInfos !== undefined) {
      // Preserve original encoding format for round-trip fidelity
      this.writeByte(header | addInfos);
      switch (addInfos) {
        case CborKinds.AI_1BYTE:
          this.writeByte(Number(length));
          break;
        case CborKinds.AI_2BYTE:
          this.writeUint16BE(Number(length));
          break;
        case CborKinds.AI_4BYTE:
          this.writeUint32BE(Number(length));
          break;
        case CborKinds.AI_8BYTE:
          this.writeBigUint64BE(length);
          break;
        // addInfos < 24: inline, no following bytes
        // addInfos === 31: indefinite, handled by caller
      }
      return;
    }

    // Canonical (shortest) encoding
    if (length < 24n) {
      this.writeByte(header | Number(length));
    } else if (length < BigInt(CborKinds.OVERFLOW_1)) {
      this.writeByte(header | CborKinds.AI_1BYTE);
      this.writeByte(Number(length));
    } else if (length < BigInt(CborKinds.OVERFLOW_2)) {
      this.writeByte(header | CborKinds.AI_2BYTE);
      this.writeUint16BE(Number(length));
    } else if (length < CborKinds.OVERFLOW_4) {
      this.writeByte(header | CborKinds.AI_4BYTE);
      this.writeUint32BE(Number(length));
    } else {
      this.writeByte(header | CborKinds.AI_8BYTE);
      this.writeBigUint64BE(length);
    }
  }

  writeItem(item: CborSchemaType): void {
    switch (item._tag) {
      case CborKinds.UInt: {
        if (item.num > CborKinds.MAX_UINT64) {
          this.writeBignum(2n, item.num);
        } else {
          this.writeTypeAndLength(CborKinds.UInt, item.num, item.addInfos);
        }
        break;
      }

      case CborKinds.NegInt: {
        if (item.num < CborKinds.MIN_NEG_INT64) {
          this.writeBignum(3n, -1n - item.num);
        } else {
          this.writeTypeAndLength(CborKinds.NegInt, -1n - item.num, item.addInfos);
        }
        break;
      }

      case CborKinds.Bytes: {
        if (item.chunks) {
          this.writeByte((CborKinds.Bytes << CborKinds.MAJOR_TYPE_SHIFT) | CborKinds.AI_INDEFINITE);
          for (const chunk of item.chunks) this.writeItem(chunk);
          this.writeByte(CborKinds.BREAK);
        } else {
          this.writeTypeAndLength(CborKinds.Bytes, BigInt(item.bytes.length), item.addInfos);
          this.writeBytes(item.bytes);
        }
        break;
      }

      case CborKinds.Text: {
        if (item.chunks) {
          this.writeByte((CborKinds.Text << CborKinds.MAJOR_TYPE_SHIFT) | CborKinds.AI_INDEFINITE);
          for (const chunk of item.chunks) this.writeItem(chunk);
          this.writeByte(CborKinds.BREAK);
        } else {
          const utf8 = textEncoder.encode(item.text);
          this.writeTypeAndLength(CborKinds.Text, BigInt(utf8.length), item.addInfos);
          this.writeBytes(utf8);
        }
        break;
      }

      case CborKinds.Array: {
        if (item.addInfos === CborKinds.AI_INDEFINITE) {
          this.writeByte((CborKinds.Array << CborKinds.MAJOR_TYPE_SHIFT) | CborKinds.AI_INDEFINITE);
          for (const elem of item.items) this.writeItem(elem);
          this.writeByte(CborKinds.BREAK);
        } else {
          this.writeTypeAndLength(CborKinds.Array, BigInt(item.items.length), item.addInfos);
          for (const elem of item.items) this.writeItem(elem);
        }
        break;
      }

      case CborKinds.Map: {
        if (item.addInfos === CborKinds.AI_INDEFINITE) {
          this.writeByte((CborKinds.Map << CborKinds.MAJOR_TYPE_SHIFT) | CborKinds.AI_INDEFINITE);
          for (const { k, v } of item.entries) {
            this.writeItem(k);
            this.writeItem(v);
          }
          this.writeByte(CborKinds.BREAK);
        } else {
          this.writeTypeAndLength(CborKinds.Map, BigInt(item.entries.length), item.addInfos);
          for (const { k, v } of item.entries) {
            this.writeItem(k);
            this.writeItem(v);
          }
        }
        break;
      }

      case CborKinds.Tag: {
        this.writeTypeAndLength(CborKinds.Tag, item.tag, item.addInfos);
        this.writeItem(item.data);
        break;
      }

      case CborKinds.Simple: {
        const header = CborKinds.Simple << CborKinds.MAJOR_TYPE_SHIFT;
        const v = item.value;
        if (v === false) {
          this.writeByte(header | CborKinds.SIMPLE_FALSE);
        } else if (v === true) {
          this.writeByte(header | CborKinds.SIMPLE_TRUE);
        } else if (v === null) {
          this.writeByte(header | CborKinds.SIMPLE_NULL);
        } else if (v === undefined) {
          this.writeByte(header | CborKinds.SIMPLE_UNDEFINED);
        } else {
          // BigDecimal: float or simple integer value
          const addInfos = item.addInfos;
          if (addInfos === CborKinds.AI_2BYTE) {
            this.writeByte(header | CborKinds.AI_2BYTE);
            this.writeFloat16BE(BigDecimal.toNumberUnsafe(v));
          } else if (addInfos === CborKinds.AI_4BYTE) {
            this.writeByte(header | CborKinds.AI_4BYTE);
            this.writeFloat32BE(BigDecimal.toNumberUnsafe(v));
          } else if (addInfos === CborKinds.AI_8BYTE) {
            this.writeByte(header | CborKinds.AI_8BYTE);
            this.writeFloat64BE(BigDecimal.toNumberUnsafe(v));
          } else if (addInfos === CborKinds.AI_1BYTE) {
            // Simple value 24-255
            this.writeByte(header | CborKinds.AI_1BYTE);
            this.writeByte(Number(BigDecimal.toNumberUnsafe(v)));
          } else if (addInfos !== undefined && addInfos < CborKinds.SIMPLE_FALSE) {
            // Simple value 0-19 (inline)
            this.writeByte(header | addInfos);
          } else {
            // Default: float64
            this.writeByte(header | CborKinds.AI_8BYTE);
            this.writeFloat64BE(BigDecimal.toNumberUnsafe(v));
          }
        }
        break;
      }
    }
  }

  private writeBignum(tag: bigint, value: bigint): void {
    let hex = value.toString(16);
    if (hex.length % 2 !== 0) hex = "0" + hex;
    const bignumBytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bignumBytes.length; i++) {
      bignumBytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    this.writeTypeAndLength(CborKinds.Tag, tag);
    this.writeTypeAndLength(CborKinds.Bytes, BigInt(bignumBytes.length));
    this.writeBytes(bignumBytes);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export const encodeSync = (obj: CborSchemaType): Uint8Array => {
  const writer = new CborWriter();
  writer.writeItem(obj);
  return writer.finish();
};

export const encode = (obj: CborSchemaType): Effect.Effect<Uint8Array, CborEncodeError> =>
  Effect.try({
    try: () => encodeSync(obj),
    catch: (e) => new CborEncodeError({ cause: e }),
  });
