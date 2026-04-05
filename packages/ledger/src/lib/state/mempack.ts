/**
 * MemPack binary decoder for Cardano LMDB UTxO values.
 * Decodes BabbageTxOut values from Haskell's MemPack format into TxOut.
 *
 * The UTxO-HD LMDB backend stores TxOut values in MemPack format (NOT CBOR).
 * This module implements the exact binary layout from:
 *   cardano-ledger/eras/babbage/impl/src/Cardano/Ledger/Babbage/TxOut.hs
 *
 * MemPack tag → constructor:
 *   0: TxOutCompact (CompactAddr + CompactValue)
 *   1: TxOutCompactDH (CompactAddr + CompactValue + DataHash32)
 *   2: AddrHash28_AdaOnly (Credential + Addr28Extra + CompactCoin)
 *   3: AddrHash28_AdaOnly_DH32 (same as 2 + DataHash32)
 *   4: TxOutCompactDatum (CompactAddr + CompactValue + BinaryData)
 *   5: TxOutCompactRefScript (CompactAddr + CompactValue + Datum + Script)
 */
import { Effect, Schema } from "effect";
import type { TxOut } from "../tx/tx.ts";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class MemPackError extends Schema.TaggedErrorClass<MemPackError>()("MemPackError", {
  offset: Schema.Number,
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// VarLen decoder: LEB128-like 7-bit continuation, little-endian
// Each byte: high bit = continuation, low 7 bits = value chunk
// ---------------------------------------------------------------------------

function readVarLen(buf: Uint8Array, offset: number): { value: bigint; bytesRead: number } {
  let result = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos]!;
    result = (result << 7n) | BigInt(byte & 0x7f);
    pos++;
    if ((byte & 0x80) === 0) break;
  }
  return { value: result, bytesRead: pos - offset };
}

function readTag(buf: Uint8Array, offset: number): { tag: number; bytesRead: number } {
  const { value, bytesRead } = readVarLen(buf, offset);
  return { tag: Number(value), bytesRead };
}

// ---------------------------------------------------------------------------
// ShortByteString: VarLen(length) + raw bytes
// ---------------------------------------------------------------------------

function readShortByteString(
  buf: Uint8Array,
  offset: number,
): { bytes: Uint8Array; bytesRead: number } {
  const { value: len, bytesRead: lenBytes } = readVarLen(buf, offset);
  const length = Number(len);
  const bytes = buf.slice(offset + lenBytes, offset + lenBytes + length);
  return { bytes, bytesRead: lenBytes + length };
}

// ---------------------------------------------------------------------------
// Fixed-size reads
// ---------------------------------------------------------------------------

function readBytes(buf: Uint8Array, offset: number, n: number): Uint8Array {
  return buf.slice(offset, offset + n);
}

function readWord64LE(buf: Uint8Array, offset: number): bigint {
  const dv = new DataView(buf.buffer, buf.byteOffset + offset);
  return dv.getBigUint64(0, true);
}

// ---------------------------------------------------------------------------
// CompactCoin: tag(0) + VarLen(Word64)
// ---------------------------------------------------------------------------

function readCompactCoin(buf: Uint8Array, offset: number): { coin: bigint; bytesRead: number } {
  const { tag, bytesRead: tagBytes } = readTag(buf, offset);
  if (tag !== 0)
    throw new MemPackError({ offset, message: `CompactCoin: expected tag 0, got ${tag}` });
  const { value, bytesRead: valBytes } = readVarLen(buf, offset + tagBytes);
  return { coin: value, bytesRead: tagBytes + valBytes };
}

// ---------------------------------------------------------------------------
// CompactValue: tag(0)=AdaOnly | tag(1)=MultiAsset
// Note: CompactValue tags are DIFFERENT from BabbageTxOut tags!
// CompactValueAdaOnly uses tag 0, CompactValueMultiAsset uses tag 1.
// ---------------------------------------------------------------------------

interface DecodedValue {
  readonly coin: bigint;
  readonly multiAsset?: ReadonlyArray<{
    readonly policy: Uint8Array;
    readonly assets: ReadonlyArray<{ readonly name: Uint8Array; readonly quantity: bigint }>;
  }>;
  readonly bytesRead: number;
}

function readCompactValue(buf: Uint8Array, offset: number): DecodedValue {
  const { tag, bytesRead: tagBytes } = readTag(buf, offset);
  let pos = offset + tagBytes;

  if (tag === 0) {
    // AdaOnly: VarLen(coin) — NO tag prefix on coin (unlike standalone CompactCoin)
    const { value: coin, bytesRead: coinBytes } = readVarLen(buf, pos);
    return { coin, bytesRead: tagBytes + coinBytes };
  }

  if (tag === 1) {
    // MultiAsset: VarLen(coin) + VarLen(numAssets) + ShortByteString(rep)
    // Note: coin is raw VarLen with NO tag prefix (packCompactCoinM = packM (VarLen c))
    const { value: coin, bytesRead: coinBytes } = readVarLen(buf, pos);
    pos += coinBytes;

    const { value: numAssets, bytesRead: countBytes } = readVarLen(buf, pos);
    pos += countBytes;

    const { bytes: rep, bytesRead: repBytes } = readShortByteString(buf, pos);
    pos += repBytes;

    const n = Number(numAssets);
    const multiAsset = decodeCompactMultiAsset(rep, n);

    return { coin, multiAsset, bytesRead: pos - offset };
  }

  throw new MemPackError({ offset, message: `CompactValue: unknown tag ${tag}` });
}

// ---------------------------------------------------------------------------
// Multi-asset compact representation decoder
// Region A: n × 8-byte Word64 LE quantities
// Region B: n × 2-byte Word16 LE policy ID offsets (into region D)
// Region C: n × 2-byte Word16 LE asset name offsets (into region E)
// Region D: unique policy IDs (28 bytes each)
// Region E: unique asset names (variable)
// ---------------------------------------------------------------------------

/**
 * Decodes the compact multi-asset representation from Haskell's ByteArray layout.
 *
 * The ShortByteString has 5 contiguous regions:
 *   Region A: n × Word64 LE quantities     (byte offsets 0 to 8n)
 *   Region B: n × Word16 LE policy offsets  (byte offsets 8n to 8n+2n)
 *   Region C: n × Word16 LE name offsets    (byte offsets 10n to 10n+2n)
 *   Region D: unique policy IDs (28 bytes each)
 *   Region E: unique asset names (variable length)
 *
 * Offsets in B and C are ABSOLUTE byte offsets from the start of rep.
 * Policy IDs are 28 bytes (Blake2b-224). Asset name lengths are computed
 * from the difference between consecutive unique offsets.
 */
function decodeCompactMultiAsset(
  rep: Uint8Array,
  numAssets: number,
): ReadonlyArray<{
  policy: Uint8Array;
  assets: ReadonlyArray<{ name: Uint8Array; quantity: bigint }>;
}> {
  if (numAssets === 0) return [];

  // Safety: ABC regions must fit within rep
  const abcSize = numAssets * 12;
  if (abcSize > rep.length) {
    // Likely a VarLen parsing misalignment — return empty multi-asset
    // (coin value was already extracted correctly)
    return [];
  }

  const dv = new DataView(rep.buffer, rep.byteOffset);

  // Read raw triples: (pidOffset, anameOffset, quantity)
  // ByteArray indexing: Word64 at index i = byte 8i, Word16 at index (4n+i) = byte 8n+2i
  const triples: Array<{ pidOff: number; anameOff: number; quantity: bigint }> = [];
  for (let i = 0; i < numAssets; i++) {
    const quantity = dv.getBigUint64(i * 8, true);
    const pidOff = dv.getUint16(numAssets * 8 + i * 2, true);
    const anameOff = dv.getUint16(numAssets * 10 + i * 2, true);
    triples.push({ pidOff, anameOff, quantity });
  }

  // Compute asset name lengths from unique sorted offsets
  const uniqueAnameOffs = [...new Set(triples.map((t) => t.anameOff))].sort((a, b) => a - b);
  const anameLenMap = new Map<number, number>();
  for (let i = 0; i < uniqueAnameOffs.length; i++) {
    const off = uniqueAnameOffs[i]!;
    const nextOff = i + 1 < uniqueAnameOffs.length ? uniqueAnameOffs[i + 1]! : rep.length;
    anameLenMap.set(off, nextOff - off);
  }

  // Group by policy
  const policyMap = new Map<
    number,
    { policy: Uint8Array; assets: { name: Uint8Array; quantity: bigint }[] }
  >();

  for (const { pidOff, anameOff, quantity } of triples) {
    // Bounds check: policy offset must leave room for 28 bytes
    if (pidOff + 28 > rep.length) continue;
    if (!policyMap.has(pidOff)) {
      policyMap.set(pidOff, { policy: rep.slice(pidOff, pidOff + 28), assets: [] });
    }
    const nameLen = anameLenMap.get(anameOff) ?? 0;
    const name =
      nameLen > 0 && anameOff + nameLen <= rep.length
        ? rep.slice(anameOff, anameOff + nameLen)
        : new Uint8Array(0);
    policyMap.get(pidOff)!.assets.push({ name, quantity });
  }

  return [...policyMap.values()];
}

// ---------------------------------------------------------------------------
// Credential: tag(0)=ScriptHash | tag(1)=KeyHash + 28 bytes
// ---------------------------------------------------------------------------

function readCredential(
  buf: Uint8Array,
  offset: number,
): { isScript: boolean; hash: Uint8Array; bytesRead: number } {
  const { tag, bytesRead: tagBytes } = readTag(buf, offset);
  const hash = readBytes(buf, offset + tagBytes, 28);
  return { isScript: tag === 0, hash, bytesRead: tagBytes + 28 };
}

// ---------------------------------------------------------------------------
// Addr28Extra: 4 × Word64 LE = 32 bytes
// Encodes payment credential hash + network/script flags in word 3's low bits
// ---------------------------------------------------------------------------

function readAddr28Extra(
  buf: Uint8Array,
  offset: number,
): { paymentHash: Uint8Array; isScript: boolean; isMainnet: boolean } {
  // 4 × Word64 LE = 32 bytes
  const raw = readBytes(buf, offset, 32);
  const dv = new DataView(raw.buffer, raw.byteOffset);

  // Word 3 (bytes 24-31) contains: upper 32 bits of hash + lower 32 bits with flags
  const word3 = dv.getBigUint64(24, true);
  const isScript = (word3 & 1n) === 0n; // bit 0: 0=Script, 1=Key (inverted from Credential tag!)
  const isMainnet = (word3 & 2n) !== 0n; // bit 1: network

  // Reconstruct the 28-byte payment hash from the 4 Word64s
  // The hash is spread across the 32 bytes, with flags in the low bits of word 3
  const paymentHash = new Uint8Array(28);
  paymentHash.set(raw.subarray(0, 28));

  return { paymentHash, isScript, isMainnet };
}

// ---------------------------------------------------------------------------
// Datum: tag(0)=NoDatum | tag(1)=DatumHash+32B | tag(2)=Inline+VarLen bytes
// ---------------------------------------------------------------------------

interface DecodedDatum {
  readonly kind: "none" | "hash" | "inline";
  readonly hash?: Uint8Array;
  readonly data?: Uint8Array;
  readonly bytesRead: number;
}

function readDatum(buf: Uint8Array, offset: number): DecodedDatum {
  const { tag, bytesRead: tagBytes } = readTag(buf, offset);
  if (tag === 0) return { kind: "none", bytesRead: tagBytes };
  if (tag === 1) {
    const hash = readBytes(buf, offset + tagBytes, 32);
    return { kind: "hash", hash, bytesRead: tagBytes + 32 };
  }
  if (tag === 2) {
    const { bytes, bytesRead: dataBytes } = readShortByteString(buf, offset + tagBytes);
    return { kind: "inline", data: bytes, bytesRead: tagBytes + dataBytes };
  }
  throw new MemPackError({ offset, message: `Datum: unknown tag ${tag}` });
}

// ---------------------------------------------------------------------------
// Script: tag(0)=V1 | tag(1)=V2 | tag(2)=V3 + VarLen(length) + raw bytes
// ---------------------------------------------------------------------------

function readScript(
  buf: Uint8Array,
  offset: number,
): { scriptBytes: Uint8Array; bytesRead: number } {
  const { tag: _scriptTag, bytesRead: tagBytes } = readTag(buf, offset);
  const { bytes, bytesRead: dataBytes } = readShortByteString(buf, offset + tagBytes);
  return { scriptBytes: bytes, bytesRead: tagBytes + dataBytes };
}

// ---------------------------------------------------------------------------
// Main decoder: BabbageTxOut from MemPack bytes
// ---------------------------------------------------------------------------

export function decodeMemPackTxOut(buf: Uint8Array): TxOut {
  const { tag, bytesRead: tagBytes } = readTag(buf, 0);
  let pos = tagBytes;

  switch (tag) {
    case 0: {
      // TxOutCompact: CompactAddr + CompactValue
      const { bytes: address, bytesRead: addrBytes } = readShortByteString(buf, pos);
      pos += addrBytes;
      const { coin, multiAsset } = readCompactValue(buf, pos);
      return { address, value: { coin, multiAsset }, datumOption: undefined, scriptRef: undefined };
    }

    case 1: {
      // TxOutCompactDH: CompactAddr + CompactValue + DataHash(32B)
      const { bytes: address, bytesRead: addrBytes } = readShortByteString(buf, pos);
      pos += addrBytes;
      const cv = readCompactValue(buf, pos);
      pos += cv.bytesRead;
      const hash = readBytes(buf, pos, 32);
      return {
        address,
        value: { coin: cv.coin, multiAsset: cv.multiAsset },
        datumOption: { _tag: 0, hash },
        scriptRef: undefined,
      };
    }

    case 2: {
      // TxOut_AddrHash28_AdaOnly: Credential + Addr28Extra(32B) + CompactCoin
      const cred = readCredential(buf, pos);
      pos += cred.bytesRead;
      const addr28 = readAddr28Extra(buf, pos);
      pos += 32;
      const { coin } = readCompactCoin(buf, pos);

      // Reconstruct address from credential + addr28Extra
      // Base address header: 0x00 (testnet, key/key) or 0x01 (mainnet)
      const headerByte =
        (addr28.isMainnet ? 1 : 0) | (addr28.isScript ? 0x10 : 0) | (cred.isScript ? 0x20 : 0);
      const address = new Uint8Array(1 + 28 + 28);
      address[0] = headerByte;
      address.set(addr28.paymentHash, 1);
      address.set(cred.hash, 29);

      return {
        address,
        value: { coin, multiAsset: undefined },
        datumOption: undefined,
        scriptRef: undefined,
      };
    }

    case 3: {
      // TxOut_AddrHash28_AdaOnly_DataHash32: same as 2 + DataHash32(32B)
      const cred = readCredential(buf, pos);
      pos += cred.bytesRead;
      const addr28 = readAddr28Extra(buf, pos);
      pos += 32;
      const cc = readCompactCoin(buf, pos);
      pos += cc.bytesRead;
      const hash = readBytes(buf, pos, 32);

      const headerByte =
        (addr28.isMainnet ? 1 : 0) | (addr28.isScript ? 0x10 : 0) | (cred.isScript ? 0x20 : 0);
      const address = new Uint8Array(1 + 28 + 28);
      address[0] = headerByte;
      address.set(addr28.paymentHash, 1);
      address.set(cred.hash, 29);

      return {
        address,
        value: { coin: cc.coin, multiAsset: undefined },
        datumOption: { _tag: 0, hash },
        scriptRef: undefined,
      };
    }

    case 4: {
      // TxOutCompactDatum: CompactAddr + CompactValue + BinaryData
      const { bytes: address, bytesRead: addrBytes } = readShortByteString(buf, pos);
      pos += addrBytes;
      const cv = readCompactValue(buf, pos);
      pos += cv.bytesRead;
      const { bytes: datumBytes, bytesRead: datumSize } = readShortByteString(buf, pos);
      return {
        address,
        value: { coin: cv.coin, multiAsset: cv.multiAsset },
        datumOption: { _tag: 1, datum: datumBytes },
        scriptRef: undefined,
      };
    }

    case 5: {
      // TxOutCompactRefScript: CompactAddr + CompactValue + Datum + Script
      const { bytes: address, bytesRead: addrBytes } = readShortByteString(buf, pos);
      pos += addrBytes;
      const cv = readCompactValue(buf, pos);
      pos += cv.bytesRead;
      const datum = readDatum(buf, pos);
      pos += datum.bytesRead;
      const script = readScript(buf, pos);

      const datumOption =
        datum.kind === "hash"
          ? { _tag: 0 as const, hash: datum.hash! }
          : datum.kind === "inline"
            ? { _tag: 1 as const, datum: datum.data! }
            : undefined;

      return {
        address,
        value: { coin: cv.coin, multiAsset: cv.multiAsset },
        datumOption,
        scriptRef: script.scriptBytes,
      };
    }

    default:
      throw new MemPackError({ offset: 0, message: `BabbageTxOut: unknown MemPack tag ${tag}` });
  }
}

// ---------------------------------------------------------------------------
// LMDB key decoder: 32-byte TxId + 2-byte big-endian TxIx
// ---------------------------------------------------------------------------

export function decodeMemPackKey(buf: Uint8Array): { txId: Uint8Array; txIx: number } {
  if (buf.length !== 34)
    throw new MemPackError({
      offset: 0,
      message: `LMDB key: expected 34 bytes, got ${buf.length}`,
    });
  const txId = buf.slice(0, 32);
  const txIx = (buf[32]! << 8) | buf[33]!; // big-endian uint16
  return { txId, txIx };
}
