import { BigDecimal, Config, Effect } from "effect";
import { CborEncodeError } from "../CborError";
import { CborKinds, type CborValue, CborValue as CborValueSchema } from "../CborValue";

// Module-level singleton — TextEncoder is thread-safe and has no per-call
// state, so one instance is reused for every encode.
const TEXT_ENCODER = new TextEncoder();

// Growable ArrayBuffer (ES2025): the buffer resizes in place; the associated
// length-tracking DataView and Uint8Array see the new byteLength automatically.
// 16 MiB default upper bound mirrors the decoder's default `maxBytes` limit.
// The Config values carry a `Config.withDefault`, so the only way
// yielding them can fail is an unparseable env var — a deploy-time misconfig
// rather than a recoverable runtime error. `.pipe(Effect.orDie)` folds that
// into a defect so downstream Effects see a clean `never` error channel.
export const INITIAL_CAPACITY = Effect.gen(function* () {
  return yield* Config.number("CODECS_CBOR_INITIAL_CAPACITY").pipe(Config.withDefault(256));
}).pipe(Effect.orDie);
export const MAX_CAPACITY = Effect.gen(function* () {
  return yield* Config.number("CODECS_CBOR_MAX_CAPACITY").pipe(Config.withDefault(1 << 24));
}).pipe(Effect.orDie);

export interface EncodeCapacities {
  readonly initialCapacity: number;
  readonly maxCapacity: number;
}

const DEFAULT_CAPACITIES: EncodeCapacities = {
  initialCapacity: 256,
  maxCapacity: 1 << 24,
};

export const encodeSync = (
  obj: CborValue,
  capacities: EncodeCapacities = DEFAULT_CAPACITIES,
): Uint8Array => {
  const { initialCapacity, maxCapacity } = capacities;
  let buf = new ArrayBuffer(initialCapacity, { maxByteLength: maxCapacity });
  let u8 = new Uint8Array(buf);
  let view = new DataView(buf);
  let pos = 0;

  const ensure = (needed: number): void => {
    const required = pos + needed;
    if (required <= buf.byteLength) return;
    let newCap = buf.byteLength;
    while (newCap < required) newCap *= 2;
    if (newCap > maxCapacity) newCap = maxCapacity;
    if (required > newCap) {
      throw new CborEncodeError({
        reason: { _tag: "CapacityExceeded", needed: required, cap: maxCapacity },
      });
    }
    buf.resize(newCap);
    // Length-tracking views automatically pick up the new byteLength, so no
    // reassignment is required — but engines vary on caching behaviour inside
    // tight loops. Rebinding u8/view is a no-op at runtime when supported and
    // a safe fallback otherwise.
    u8 = new Uint8Array(buf);
    view = new DataView(buf);
  };

  const writeByte = (b: number): void => {
    ensure(1);
    u8[pos++] = b;
  };

  const writeBytesInto = (bs: Uint8Array): void => {
    ensure(bs.length);
    u8.set(bs, pos);
    pos += bs.length;
  };

  const writeUint16BE = (n: number): void => {
    ensure(2);
    view.setUint16(pos, n);
    pos += 2;
  };

  const writeUint32BE = (n: number): void => {
    ensure(4);
    view.setUint32(pos, n);
    pos += 4;
  };

  const writeBigUint64BE = (n: bigint): void => {
    ensure(8);
    view.setBigUint64(pos, n);
    pos += 8;
  };

  // ES2025: DataView.setFloat16 is the native IEEE 754 binary16 writer (Bun
  // v1.1.23+, Chrome 129+, Firefox 126+, Safari 17.4+). Handles subnormal /
  // Infinity / NaN / rounding edge cases per the spec.
  const writeFloat16BE = (n: number): void => {
    ensure(2);
    view.setFloat16(pos, n, false);
    pos += 2;
  };

  const writeFloat32BE = (n: number): void => {
    ensure(4);
    view.setFloat32(pos, n);
    pos += 4;
  };

  const writeFloat64BE = (n: number): void => {
    ensure(8);
    view.setFloat64(pos, n);
    pos += 8;
  };

  const writeTypeAndLength = (majorType: number, length: bigint, addInfos?: number): void => {
    const header = majorType << CborKinds.MAJOR_TYPE_SHIFT;

    if (addInfos !== undefined) {
      // Preserve original encoding format for round-trip fidelity
      writeByte(header | addInfos);
      switch (addInfos) {
        case CborKinds.AI_1BYTE:
          writeByte(Number(length));
          break;
        case CborKinds.AI_2BYTE:
          writeUint16BE(Number(length));
          break;
        case CborKinds.AI_4BYTE:
          writeUint32BE(Number(length));
          break;
        case CborKinds.AI_8BYTE:
          writeBigUint64BE(length);
          break;
        // addInfos < 24: inline, no following bytes
        // addInfos === 31: indefinite, handled by caller
      }
      return;
    }

    // Canonical (shortest) encoding
    if (length < 24n) {
      writeByte(header | Number(length));
    } else if (length < BigInt(CborKinds.OVERFLOW_1)) {
      writeByte(header | CborKinds.AI_1BYTE);
      writeByte(Number(length));
    } else if (length < BigInt(CborKinds.OVERFLOW_2)) {
      writeByte(header | CborKinds.AI_2BYTE);
      writeUint16BE(Number(length));
    } else if (length < CborKinds.OVERFLOW_4) {
      writeByte(header | CborKinds.AI_4BYTE);
      writeUint32BE(Number(length));
    } else {
      writeByte(header | CborKinds.AI_8BYTE);
      writeBigUint64BE(length);
    }
  };

  const writeBignum = (tag: bigint, value: bigint): void => {
    // Big-endian byte width via `BigInt.prototype.toString(2)` — the
    // most-significant bit count divided up to a whole byte gives us the
    // final length in one shot, avoiding the `Array.prototype.unshift`
    // loop (which is O(n²) as the array grows).
    const byteCount = value === 0n ? 1 : Math.ceil(value.toString(2).length / 8);
    // `Array.from({ length }, mapper)` emits each big-endian byte directly
    // into its final slot — O(n) rather than O(n²). The inner shift-left
    // + 0xff mask is the canonical bignum-to-bytes idiom.
    const bignumBytes = Uint8Array.from(
      { length: byteCount },
      (_, i) => Number((value >> BigInt(8 * (byteCount - 1 - i))) & 0xffn),
    );
    writeTypeAndLength(CborKinds.Tag, tag);
    writeTypeAndLength(CborKinds.Bytes, BigInt(bignumBytes.length));
    writeBytesInto(bignumBytes);
  };

  // Dispatch via CborValueSchema.match — exhaustive, built once per encode.
  // Inner `writeItem` self-reference is resolved at call time through TDZ
  // closure capture; the explicit type annotation lets TS infer recursion.
  const writeItem: (item: CborValue) => void = CborValueSchema.match({
    [CborKinds.UInt]: (item) => {
      if (item.num > CborKinds.MAX_UINT64) {
        writeBignum(2n, item.num);
      } else {
        writeTypeAndLength(CborKinds.UInt, item.num, item.addInfos);
      }
    },
    [CborKinds.NegInt]: (item) => {
      if (item.num < CborKinds.MIN_NEG_INT64) {
        writeBignum(3n, -1n - item.num);
      } else {
        writeTypeAndLength(CborKinds.NegInt, -1n - item.num, item.addInfos);
      }
    },
    [CborKinds.Bytes]: (item) => {
      if (item.chunks) {
        writeByte((CborKinds.Bytes << CborKinds.MAJOR_TYPE_SHIFT) | CborKinds.AI_INDEFINITE);
        for (const chunk of item.chunks) writeItem(chunk);
        writeByte(CborKinds.BREAK);
      } else {
        writeTypeAndLength(CborKinds.Bytes, BigInt(item.bytes.length), item.addInfos);
        writeBytesInto(item.bytes);
      }
    },
    [CborKinds.Text]: (item) => {
      if (item.chunks) {
        writeByte((CborKinds.Text << CborKinds.MAJOR_TYPE_SHIFT) | CborKinds.AI_INDEFINITE);
        for (const chunk of item.chunks) writeItem(chunk);
        writeByte(CborKinds.BREAK);
      } else {
        // RFC 8949 §3.1: major type 3 requires well-formed UTF-8. JS strings
        // are UTF-16 and may contain unpaired surrogates; TextEncoder silently
        // substitutes U+FFFD, which would silently mutate the payload. ES2025
        // `isWellFormed` detects this up front so the encoder fails loudly.
        if (!item.text.isWellFormed()) {
          throw new CborEncodeError({
            reason: {
              _tag: "IllFormedUtf16",
              preview: item.text.slice(0, 20),
            },
          });
        }
        const utf8 = TEXT_ENCODER.encode(item.text);
        writeTypeAndLength(CborKinds.Text, BigInt(utf8.length), item.addInfos);
        writeBytesInto(utf8);
      }
    },
    [CborKinds.Array]: (item) => {
      if (item.addInfos === CborKinds.AI_INDEFINITE) {
        writeByte((CborKinds.Array << CborKinds.MAJOR_TYPE_SHIFT) | CborKinds.AI_INDEFINITE);
        for (const elem of item.items) writeItem(elem);
        writeByte(CborKinds.BREAK);
      } else {
        writeTypeAndLength(CborKinds.Array, BigInt(item.items.length), item.addInfos);
        for (const elem of item.items) writeItem(elem);
      }
    },
    [CborKinds.Map]: (item) => {
      if (item.addInfos === CborKinds.AI_INDEFINITE) {
        writeByte((CborKinds.Map << CborKinds.MAJOR_TYPE_SHIFT) | CborKinds.AI_INDEFINITE);
        for (const { k, v } of item.entries) {
          writeItem(k);
          writeItem(v);
        }
        writeByte(CborKinds.BREAK);
      } else {
        writeTypeAndLength(CborKinds.Map, BigInt(item.entries.length), item.addInfos);
        for (const { k, v } of item.entries) {
          writeItem(k);
          writeItem(v);
        }
      }
    },
    [CborKinds.Tag]: (item) => {
      writeTypeAndLength(CborKinds.Tag, item.tag, item.addInfos);
      writeItem(item.data);
    },
    [CborKinds.Simple]: (item) => {
      const header = CborKinds.Simple << CborKinds.MAJOR_TYPE_SHIFT;
      const v = item.value;
      if (v === false) {
        writeByte(header | CborKinds.SIMPLE_FALSE);
      } else if (v === true) {
        writeByte(header | CborKinds.SIMPLE_TRUE);
      } else if (v === null) {
        writeByte(header | CborKinds.SIMPLE_NULL);
      } else if (v === undefined) {
        writeByte(header | CborKinds.SIMPLE_UNDEFINED);
      } else {
        // BigDecimal: float or simple integer value
        const addInfos = item.addInfos;
        const n = BigDecimal.toNumberUnsafe(v);
        const isFloatAddInfo =
          addInfos === CborKinds.AI_2BYTE ||
          addInfos === CborKinds.AI_4BYTE ||
          addInfos === CborKinds.AI_8BYTE ||
          addInfos === undefined;
        // RFC 8949 §4.2.2 — canonical NaN is the three-byte Float16 pattern
        // 0xF9 0x7E 0x00. ES2025 NumericToRawBytes (§25.1.3.17) leaves the
        // NaN bit pattern implementation-defined, so DataView.setFloat*(NaN)
        // can drift between V8 / JSC / Bun. Normalize explicitly.
        if (Number.isNaN(n) && isFloatAddInfo) {
          writeByte(header | CborKinds.AI_2BYTE);
          writeByte(0x7e);
          writeByte(0x00);
        } else {
          switch (addInfos) {
            case CborKinds.AI_2BYTE:
              writeByte(header | CborKinds.AI_2BYTE);
              writeFloat16BE(n);
              break;
            case CborKinds.AI_4BYTE:
              writeByte(header | CborKinds.AI_4BYTE);
              writeFloat32BE(n);
              break;
            case CborKinds.AI_8BYTE:
              writeByte(header | CborKinds.AI_8BYTE);
              writeFloat64BE(n);
              break;
            case CborKinds.AI_1BYTE:
              // Simple value 24-255
              writeByte(header | CborKinds.AI_1BYTE);
              writeByte(Number(n));
              break;
            default:
              if (addInfos !== undefined && addInfos < CborKinds.SIMPLE_FALSE) {
                // Simple value 0-19 (inline)
                writeByte(header | addInfos);
              } else {
                // Default: float64
                writeByte(header | CborKinds.AI_8BYTE);
                writeFloat64BE(n);
              }
          }
        }
      }
    },
  });

  writeItem(obj);
  // ES2024 ArrayBuffer.prototype.transferToFixedLength: zero-copy truncation
  // to exactly `pos` bytes. The growable buffer becomes detached; the returned
  // Uint8Array owns a fixed-length backing.
  return new Uint8Array(buf.transferToFixedLength(pos));
};

export const encode = (obj: CborValue): Effect.Effect<Uint8Array, CborEncodeError> =>
  Effect.gen(function* () {
    const initialCapacity = yield* INITIAL_CAPACITY;
    const maxCapacity = yield* MAX_CAPACITY;
    return yield* Effect.try({
      try: () => encodeSync(obj, { initialCapacity, maxCapacity }),
      catch: (e) => new CborEncodeError({ cause: e }),
    });
  });
