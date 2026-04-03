import { BigDecimal, Effect } from "effect";
import { CborDecodeError, CborKinds, type CborSchemaType } from "./schema";

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const parseSync = (input: Uint8Array): CborSchemaType => {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let offset = 0;

  const readUint8 = (): number => {
    if (offset >= input.byteLength) throw new Error("Unexpected end of input");
    return view.getUint8(offset++);
  };

  const readUint16BE = (): number => {
    if (offset + 2 > input.byteLength) throw new Error("Unexpected end of input");
    const v = view.getUint16(offset);
    offset += 2;
    return v;
  };

  const readUint32BE = (): number => {
    if (offset + 4 > input.byteLength) throw new Error("Unexpected end of input");
    const v = view.getUint32(offset);
    offset += 4;
    return v;
  };

  const readBigUint64BE = (): bigint => {
    if (offset + 8 > input.byteLength) throw new Error("Unexpected end of input");
    const v = view.getBigUint64(offset);
    offset += 8;
    return v;
  };

  const readBytes = (n: number): Uint8Array => {
    if (offset + n > input.byteLength) throw new Error("Unexpected end of input");
    const slice = input.subarray(offset, offset + n);
    offset += n;
    return slice;
  };

  const readFloat16 = (): number => {
    const halfBits = readUint16BE();
    const sign = halfBits & 0x8000;
    let exponent = halfBits & 0x7c00;
    const fraction = halfBits & 0x03ff;

    if (exponent === 0x7c00) {
      // Infinity or NaN
      exponent = 0xff << 10;
    } else if (exponent !== 0) {
      // Normal number: bias adjustment 127-15 = 112
      exponent += (127 - 15) << 10;
    } else if (fraction !== 0) {
      // Subnormal half → subnormal single conversion
      return (sign ? -1 : 1) * fraction * 5.960464477539063e-8;
    }

    const buf = new ArrayBuffer(4);
    const dv = new DataView(buf);
    dv.setUint32(0, (sign << 16) | (exponent << 13) | (fraction << 13));
    return dv.getFloat32(0);
  };

  const readFloat32 = (): number => {
    if (offset + 4 > input.byteLength) throw new Error("Unexpected end of input");
    const v = view.getFloat32(offset);
    offset += 4;
    return v;
  };

  const readFloat64 = (): number => {
    if (offset + 8 > input.byteLength) throw new Error("Unexpected end of input");
    const v = view.getFloat64(offset);
    offset += 8;
    return v;
  };

  const getLength = (addInfos: number): bigint => {
    if (addInfos < CborKinds.AI_1BYTE) return BigInt(addInfos);
    switch (addInfos) {
      case CborKinds.AI_1BYTE:
        return BigInt(readUint8());
      case CborKinds.AI_2BYTE:
        return BigInt(readUint16BE());
      case CborKinds.AI_4BYTE:
        return BigInt(readUint32BE());
      case CborKinds.AI_8BYTE:
        return readBigUint64BE();
      case CborKinds.AI_INDEFINITE:
        return -1n;
      default:
        throw new Error(`Invalid additional info: ${addInfos}`);
    }
  };

  const skipBreak = (): boolean => {
    if (offset < input.byteLength && input[offset] === CborKinds.BREAK) {
      offset++;
      return true;
    }
    return false;
  };

  const concatBytes = (chunks: Uint8Array[]): Uint8Array => {
    let totalLen = 0;
    for (const c of chunks) totalLen += c.length;
    const result = new Uint8Array(totalLen);
    let pos = 0;
    for (const c of chunks) {
      result.set(c, pos);
      pos += c.length;
    }
    return result;
  };

  const bytesToBigInt = (bytes: Uint8Array): bigint => {
    if (bytes.length === 0) return 0n;
    let hex = "";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
    return BigInt("0x" + hex);
  };

  const parseCborItem = (): CborSchemaType => {
    const headerByte = readUint8();
    const majorType = headerByte >> CborKinds.MAJOR_TYPE_SHIFT;
    const addInfos = headerByte & CborKinds.ADD_INFOS_MASK;

    // Major type 7: floats handled before getLength
    if (majorType === CborKinds.Simple) {
      switch (addInfos) {
        case CborKinds.AI_2BYTE: {
          const f = readFloat16();
          return { _tag: CborKinds.Simple, value: BigDecimal.fromNumberUnsafe(f), addInfos };
        }
        case CborKinds.AI_4BYTE: {
          const f = readFloat32();
          return { _tag: CborKinds.Simple, value: BigDecimal.fromNumberUnsafe(f), addInfos };
        }
        case CborKinds.AI_8BYTE: {
          const f = readFloat64();
          return { _tag: CborKinds.Simple, value: BigDecimal.fromNumberUnsafe(f), addInfos };
        }
        case CborKinds.SIMPLE_FALSE:
          return { _tag: CborKinds.Simple, value: false, addInfos };
        case CborKinds.SIMPLE_TRUE:
          return { _tag: CborKinds.Simple, value: true, addInfos };
        case CborKinds.SIMPLE_NULL:
          return { _tag: CborKinds.Simple, value: null, addInfos };
        case CborKinds.SIMPLE_UNDEFINED:
          return { _tag: CborKinds.Simple, value: undefined, addInfos };
        case CborKinds.AI_1BYTE: {
          const val = readUint8();
          return { _tag: CborKinds.Simple, value: BigDecimal.fromBigInt(BigInt(val)), addInfos };
        }
        default: {
          if (addInfos < CborKinds.SIMPLE_FALSE) {
            return {
              _tag: CborKinds.Simple,
              value: BigDecimal.fromBigInt(BigInt(addInfos)),
              addInfos,
            };
          }
          throw new Error(`Invalid simple value addInfos: ${addInfos}`);
        }
      }
    }

    const length = getLength(addInfos);

    switch (majorType as CborKinds) {
      case CborKinds.UInt:
        return { _tag: CborKinds.UInt, num: length, addInfos };

      case CborKinds.NegInt:
        return { _tag: CborKinds.NegInt, num: -1n - length, addInfos };

      case CborKinds.Bytes: {
        if (length < 0n) {
          // Indefinite-length bytes
          const chunks: CborSchemaType[] = [];
          const rawChunks: Uint8Array[] = [];
          while (!skipBreak()) {
            const chunk = parseCborItem();
            chunks.push(chunk);
            if (chunk._tag === CborKinds.Bytes) rawChunks.push(chunk.bytes);
          }
          return { _tag: CborKinds.Bytes, bytes: concatBytes(rawChunks), addInfos, chunks };
        }
        return { _tag: CborKinds.Bytes, bytes: readBytes(Number(length)), addInfos };
      }

      case CborKinds.Text: {
        if (length < 0n) {
          // Indefinite-length text
          const chunks: CborSchemaType[] = [];
          const parts: string[] = [];
          while (!skipBreak()) {
            const chunk = parseCborItem();
            chunks.push(chunk);
            if (chunk._tag === CborKinds.Text) parts.push(chunk.text);
          }
          return { _tag: CborKinds.Text, text: parts.join(""), addInfos, chunks };
        }
        const bytes = readBytes(Number(length));
        return { _tag: CborKinds.Text, text: textDecoder.decode(bytes), addInfos };
      }

      case CborKinds.Array: {
        if (length < 0n) {
          const items: CborSchemaType[] = [];
          while (!skipBreak()) items.push(parseCborItem());
          return { _tag: CborKinds.Array, items, addInfos };
        }
        const n = Number(length);
        const items: CborSchemaType[] = new Array(n);
        for (let i = 0; i < n; i++) items[i] = parseCborItem();
        return { _tag: CborKinds.Array, items, addInfos };
      }

      case CborKinds.Map: {
        if (length < 0n) {
          const entries: { k: CborSchemaType; v: CborSchemaType }[] = [];
          while (!skipBreak()) {
            const k = parseCborItem();
            const v = parseCborItem();
            entries.push({ k, v });
          }
          return { _tag: CborKinds.Map, entries, addInfos };
        }
        const n = Number(length);
        const entries: { k: CborSchemaType; v: CborSchemaType }[] = new Array(n);
        for (let i = 0; i < n; i++) {
          const k = parseCborItem();
          const v = parseCborItem();
          entries[i] = { k, v };
        }
        return { _tag: CborKinds.Map, entries, addInfos };
      }

      case CborKinds.Tag: {
        const tag = length;
        const data = parseCborItem();
        // Auto-promote bignums (tags 2/3)
        if (tag === 2n && data._tag === CborKinds.Bytes) {
          return { _tag: CborKinds.UInt, num: bytesToBigInt(data.bytes) };
        }
        if (tag === 3n && data._tag === CborKinds.Bytes) {
          return { _tag: CborKinds.NegInt, num: -1n - bytesToBigInt(data.bytes) };
        }
        return { _tag: CborKinds.Tag, tag, data, addInfos };
      }

      default:
        throw new Error(`Unknown major type: ${majorType}`);
    }
  };

  return parseCborItem();
};

export const parse = (bytes: Uint8Array): Effect.Effect<CborSchemaType, CborDecodeError> =>
  Effect.try({
    try: () => parseSync(bytes),
    catch: (e) => new CborDecodeError({ cause: e }),
  });
