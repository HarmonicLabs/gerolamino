import { BigDecimal, Effect } from "effect";
import { sumBy } from "es-toolkit";
import { CborDecodeError } from "../CborError";
import { CborKinds, type CborValue, CborValue as CborValueSchema } from "../CborValue";

// Module-level singleton — TextDecoder is thread-safe and carries no per-call
// state, so one `fatal: true` instance is reused for every decode (rejects
// ill-formed UTF-8 inline, matching RFC 8949 §3.1).
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

export const parseSync = (input: Uint8Array): CborValue => {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let offset = 0;

  /** Typed truncation-error constructor — runtime throws are caught by
   * `parse`'s `Effect.try` boundary and pass through unchanged (the catch
   * handler already detects `CborDecodeError` instances). */
  const truncated = (needed: number) =>
    new CborDecodeError({
      operation: "parse",
      reason: {
        _tag: "Truncated",
        at: offset,
        needed,
        available: input.byteLength - offset,
      },
    });

  const readUint8 = (): number => {
    if (offset >= input.byteLength) throw truncated(1);
    return view.getUint8(offset++);
  };

  const readUint16BE = (): number => {
    if (offset + 2 > input.byteLength) throw truncated(2);
    const v = view.getUint16(offset);
    offset += 2;
    return v;
  };

  const readUint32BE = (): number => {
    if (offset + 4 > input.byteLength) throw truncated(4);
    const v = view.getUint32(offset);
    offset += 4;
    return v;
  };

  const readBigUint64BE = (): bigint => {
    if (offset + 8 > input.byteLength) throw truncated(8);
    const v = view.getBigUint64(offset);
    offset += 8;
    return v;
  };

  const readBytes = (n: number): Uint8Array => {
    if (offset + n > input.byteLength) throw truncated(n);
    const slice = input.subarray(offset, offset + n);
    offset += n;
    return slice;
  };

  // ES2025: DataView.getFloat16 is the native IEEE 754 binary16 reader
  // (Bun v1.1.23+, Chrome 129+, Firefox 126+, Safari 17.4+). Replaces ~20
  // lines of manual sign/exponent/fraction bit manipulation and handles
  // subnormal / Infinity / NaN edge cases per the spec.
  const readFloat16 = (): number => {
    if (offset + 2 > input.byteLength) throw truncated(2);
    const v = view.getFloat16(offset, false);
    offset += 2;
    return v;
  };

  const readFloat32 = (): number => {
    if (offset + 4 > input.byteLength) throw truncated(4);
    const v = view.getFloat32(offset);
    offset += 4;
    return v;
  };

  const readFloat64 = (): number => {
    if (offset + 8 > input.byteLength) throw truncated(8);
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
        throw new CborDecodeError({
          operation: "parse",
          reason: {
            _tag: "MalformedHeader",
            at: offset,
            addInfos,
            message: "Invalid additional info",
          },
        });
    }
  };

  const skipBreak = (): boolean => {
    if (offset < input.byteLength && input[offset] === CborKinds.BREAK) {
      offset++;
      return true;
    }
    return false;
  };

  const concatBytes = (chunks: readonly Uint8Array[]): Uint8Array => {
    const totalLen = sumBy(chunks, (c) => c.length);
    const result = new Uint8Array(totalLen);
    chunks.reduce((pos, c) => (result.set(c, pos), pos + c.length), 0);
    return result;
  };

  // Big-endian bytes → bigint via pure bigint arithmetic (avoids hex-string
  // round-trip). ES2020+ bigint bit-ops.
  const bytesToBigInt = (bytes: Uint8Array): bigint =>
    bytes.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);

  const parseCborItem = (): CborValue => {
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
          throw new CborDecodeError({
            operation: "parse",
            reason: {
              _tag: "MalformedHeader",
              at: offset,
              addInfos,
              message: "Invalid simple value addInfos",
            },
          });
        }
      }
    }

    const length = getLength(addInfos);

    switch (majorType) {
      case CborKinds.UInt:
        return { _tag: CborKinds.UInt, num: length, addInfos };

      case CborKinds.NegInt:
        return { _tag: CborKinds.NegInt, num: -1n - length, addInfos };

      case CborKinds.Bytes: {
        if (length < 0n) {
          // Indefinite-length bytes
          const chunks: CborValue[] = [];
          const rawChunks: Uint8Array[] = [];
          while (!skipBreak()) {
            const chunk = parseCborItem();
            chunks.push(chunk);
            if (CborValueSchema.guards[CborKinds.Bytes](chunk)) rawChunks.push(chunk.bytes);
          }
          return { _tag: CborKinds.Bytes, bytes: concatBytes(rawChunks), addInfos, chunks };
        }
        return { _tag: CborKinds.Bytes, bytes: readBytes(Number(length)), addInfos };
      }

      case CborKinds.Text: {
        if (length < 0n) {
          // Indefinite-length text
          const chunks: CborValue[] = [];
          const parts: string[] = [];
          while (!skipBreak()) {
            const chunk = parseCborItem();
            chunks.push(chunk);
            if (CborValueSchema.guards[CborKinds.Text](chunk)) parts.push(chunk.text);
          }
          return { _tag: CborKinds.Text, text: parts.join(""), addInfos, chunks };
        }
        const bytes = readBytes(Number(length));
        return { _tag: CborKinds.Text, text: TEXT_DECODER.decode(bytes), addInfos };
      }

      case CborKinds.Array: {
        if (length < 0n) {
          const items: CborValue[] = [];
          while (!skipBreak()) items.push(parseCborItem());
          return { _tag: CborKinds.Array, items, addInfos };
        }
        const items = Array.from({ length: Number(length) }, () => parseCborItem());
        return { _tag: CborKinds.Array, items, addInfos };
      }

      case CborKinds.Map: {
        if (length < 0n) {
          const entries: { k: CborValue; v: CborValue }[] = [];
          while (!skipBreak()) {
            const k = parseCborItem();
            const v = parseCborItem();
            entries.push({ k, v });
          }
          return { _tag: CborKinds.Map, entries, addInfos };
        }
        const entries = Array.from({ length: Number(length) }, () => ({
          k: parseCborItem(),
          v: parseCborItem(),
        }));
        return { _tag: CborKinds.Map, entries, addInfos };
      }

      case CborKinds.Tag: {
        const tag = length;
        const data = parseCborItem();
        // Auto-promote bignums (tags 2/3). `.guards[Bytes]` narrows `data.bytes`.
        if (tag === 2n && CborValueSchema.guards[CborKinds.Bytes](data)) {
          return { _tag: CborKinds.UInt, num: bytesToBigInt(data.bytes) };
        }
        if (tag === 3n && CborValueSchema.guards[CborKinds.Bytes](data)) {
          return { _tag: CborKinds.NegInt, num: -1n - bytesToBigInt(data.bytes) };
        }
        return { _tag: CborKinds.Tag, tag, data, addInfos };
      }

      default:
        throw new CborDecodeError({
          operation: "parse",
          reason: {
            _tag: "MalformedHeader",
            at: offset,
            majorType,
            message: `Unknown major type ${majorType}`,
          },
        });
    }
  };

  return parseCborItem();
};

export const parse = (bytes: Uint8Array): Effect.Effect<CborValue, CborDecodeError> =>
  Effect.try({
    try: () => parseSync(bytes),
    catch: (e) => (e instanceof CborDecodeError ? e : new CborDecodeError({ cause: e })),
  });

/**
 * Skip over a CBOR item in raw bytes without building an AST.
 * Returns the byte offset immediately after the item.
 *
 * Use this to extract original byte ranges from CBOR structures —
 * e.g. slicing the raw header body bytes for hashing instead of
 * re-encoding parsed AST (which may not be byte-identical).
 */
export const skipCborItem = (buf: Uint8Array, offset: number): number => {
  if (offset >= buf.byteLength) throw new Error("skipCborItem: offset past end of buffer");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerByte = buf[offset]!;
  const majorType = headerByte >> CborKinds.MAJOR_TYPE_SHIFT;
  const addInfo = headerByte & CborKinds.ADD_INFOS_MASK;
  let pos = offset + 1;

  // Simple / float (major type 7) — no length prefix, just fixed-size payload
  if (majorType === CborKinds.Simple) {
    if (addInfo < CborKinds.AI_1BYTE) return pos;
    if (addInfo === CborKinds.AI_1BYTE) return pos + 1;
    if (addInfo === CborKinds.AI_2BYTE) return pos + 2;
    if (addInfo === CborKinds.AI_4BYTE) return pos + 4;
    if (addInfo === CborKinds.AI_8BYTE) return pos + 8;
    if (addInfo === CborKinds.AI_INDEFINITE) return pos; // break
    throw new Error(`skipCborItem: invalid simple addInfo ${addInfo}`);
  }

  // Read argument (length/value) from addInfo
  let length: bigint;
  switch (addInfo) {
    case CborKinds.AI_1BYTE:
      length = BigInt(buf[pos]!);
      pos += 1;
      break;
    case CborKinds.AI_2BYTE:
      length = BigInt(view.getUint16(pos));
      pos += 2;
      break;
    case CborKinds.AI_4BYTE:
      length = BigInt(view.getUint32(pos));
      pos += 4;
      break;
    case CborKinds.AI_8BYTE:
      length = view.getBigUint64(pos);
      pos += 8;
      break;
    case CborKinds.AI_INDEFINITE:
      length = -1n;
      break;
    default:
      if (addInfo < CborKinds.AI_1BYTE) {
        length = BigInt(addInfo);
        break;
      }
      throw new Error(`skipCborItem: invalid addInfo ${addInfo}`);
  }

  switch (majorType) {
    case CborKinds.UInt: // 0 — unsigned int, no payload beyond argument
    case CborKinds.NegInt: // 1 — negative int, no payload beyond argument
      return pos;

    case CborKinds.Bytes: // 2 — byte string
    case CborKinds.Text: // 3 — text string
      if (length < 0n) {
        // Indefinite: skip chunks until break (0xff)
        while (buf[pos] !== CborKinds.BREAK) pos = skipCborItem(buf, pos);
        return pos + 1; // skip break byte
      }
      return pos + Number(length);

    case CborKinds.Array: // 4
      if (length < 0n) {
        while (buf[pos] !== CborKinds.BREAK) pos = skipCborItem(buf, pos);
        return pos + 1;
      }
      for (let i = 0; i < Number(length); i++) pos = skipCborItem(buf, pos);
      return pos;

    case CborKinds.Map: // 5
      if (length < 0n) {
        while (buf[pos] !== CborKinds.BREAK) {
          pos = skipCborItem(buf, pos); // key
          pos = skipCborItem(buf, pos); // value
        }
        return pos + 1;
      }
      for (let i = 0; i < Number(length); i++) {
        pos = skipCborItem(buf, pos); // key
        pos = skipCborItem(buf, pos); // value
      }
      return pos;

    case CborKinds.Tag: // 6 — tag number already read, skip the tagged data item
      return skipCborItem(buf, pos);

    default:
      throw new Error(`skipCborItem: unknown major type ${majorType}`);
  }
};
