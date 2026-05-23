/**
 * Inverted-index key encoders for the BlobStore-only ChainDB backend.
 *
 * Why these exist:
 *   chrome-ext can't run SQL durably in the MV3 service worker lifecycle.
 *   Skip SQL — store everything as key-value in `BlobStore` (OPFS-backed
 *   LSM WASM in chrome-ext via dedicated Worker; Zig/Haskell LSM on Bun).
 *
 *   This module adds the five new key prefixes the BlobStore-only
 *   ChainDB needs on top of the existing seven (`utxo`/`blk:`/`bidx`/
 *   `stak`/`acct`/`snap`/`coff` from `lsm-ffi`):
 *
 *     vmet  — volatile  block metadata (slot+hash → blockNo,prevHash,size)
 *     imet  — immutable block metadata (same shape)
 *     succ  — successor inverted index (parent hash → children)
 *     vtip  — volatile tip pointer (singleton)
 *     itip  — immutable tip pointer (singleton)
 *
 * Sort-order invariant:
 *   Slot is encoded big-endian so lexicographic byte order on keys
 *   equals numeric slot order. `BlobStore.scan(prefix)` over the
 *   metadata prefixes therefore returns blocks in slot ascending order
 *   without an in-memory re-sort. The successor index sorts children
 *   by (slot, hash) for the same reason.
 *
 * Atomicity:
 *   `addBlock` writes three keys (vmet, succ, vtip) in a single
 *   `BlobStore.putBatch(...)`. Rollback / promote / GC use the same
 *   batch primitive. LSM write batches provide the all-or-nothing guarantee.
 *
 * Genesis handling:
 *   prevHash for the genesis block is `null`. We encode it as 32 zero
 *   bytes. The successor scan for an all-zero parent returns the
 *   genesis block (or nothing if none exists yet) — semantically
 *   correct.
 */
import { be32, be64, concat } from "codecs";

const TEXT_ENCODER = new TextEncoder();

// ────────────────────────────────────────────────────────────────────────────
// 4-byte ASCII prefixes — distinct from every prefix exported by `lsm-ffi`
// (utxo / blk: / bidx / stak / acct / snap / coff). All five new tags
// allocated alphabetically below the existing `vmet` slot for cache
// locality on disk (LSM groups identical-prefix keys together).
// ────────────────────────────────────────────────────────────────────────────

/** Volatile block metadata prefix — `vmet`. Key suffix: `slot(8B BE) ∥ hash(32B)`. */
export const PREFIX_VMET = TEXT_ENCODER.encode("vmet");
/** Immutable block metadata prefix — `imet`. Same key suffix as `vmet`. */
export const PREFIX_IMET = TEXT_ENCODER.encode("imet");
/** Successor inverted index prefix — `succ`. Key suffix: `prevHash(32B) ∥ slot(8B BE) ∥ hash(32B)`. */
export const PREFIX_SUCC = TEXT_ENCODER.encode("succ");
/** Volatile tip pointer prefix — `vtip`. Singleton; key suffix is a single zero byte. */
export const PREFIX_VTIP = TEXT_ENCODER.encode("vtip");
/** Immutable tip pointer prefix — `itip`. Singleton; same as `vtip`. */
export const PREFIX_ITIP = TEXT_ENCODER.encode("itip");

/** Singleton-key sentinel suffix — one zero byte is the canonical
 *  "no further discriminator" suffix for tip-pointer keys. */
const SENTINEL = new Uint8Array([0x00]);

/** All-zero 32-byte sentinel for the genesis block's `prevHash`. Hoisted
 *  so every genesis-block encode reuses the same allocation. */
const ZERO_HASH_32 = new Uint8Array(32);

// ────────────────────────────────────────────────────────────────────────────
// Block metadata — `vmet` / `imet` keys + the shared 44-byte value layout.
// ────────────────────────────────────────────────────────────────────────────

/** Metadata-value byte layout: `blockNo(8B BE) ∥ prevHash(32B) ∥ size(4B BE)`.
 *  Total 44 bytes. `prevHash = null` (genesis) encodes as 32 zero bytes. */
export const encodeBlockMeta = (
  blockNo: bigint,
  prevHash: Uint8Array | null,
  sizeBytes: number,
): Uint8Array => concat(be64(blockNo), prevHash ?? ZERO_HASH_32, be32(sizeBytes));

/** Inverse of `encodeBlockMeta` — returns `null` prevHash for genesis. */
export const decodeBlockMeta = (
  value: Uint8Array,
): {
  readonly blockNo: bigint;
  readonly prevHash: Uint8Array | null;
  readonly sizeBytes: number;
} => {
  const dv = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const blockNo = dv.getBigUint64(0);
  const prevHashSlice = value.subarray(8, 40);
  const sizeBytes = dv.getUint32(40);
  // Detect genesis (all-zero) prevHash; return null so callers don't have
  // to special-case the sentinel.
  const isGenesis = prevHashSlice.every((b) => b === 0);
  return { blockNo, prevHash: isGenesis ? null : prevHashSlice, sizeBytes };
};

/** Volatile block metadata key — `vmet ∥ slot(8B BE) ∥ hash(32B)`. */
export const volatileMetaKey = (slot: bigint, hash: Uint8Array): Uint8Array =>
  concat(PREFIX_VMET, be64(slot), hash);

/** Immutable block metadata key — `imet ∥ slot(8B BE) ∥ hash(32B)`. */
export const immutableMetaKey = (slot: bigint, hash: Uint8Array): Uint8Array =>
  concat(PREFIX_IMET, be64(slot), hash);

/** Decode `(slot, hash)` from a `vmet` or `imet` key. */
export const decodeMetaKey = (
  key: Uint8Array,
): { readonly slot: bigint; readonly hash: Uint8Array } => ({
  slot: new DataView(key.buffer, key.byteOffset + 4, 8).getBigUint64(0),
  hash: key.subarray(12, 44),
});

// ────────────────────────────────────────────────────────────────────────────
// Successor inverted index — `succ` keys with empty values.
// ────────────────────────────────────────────────────────────────────────────

/** Successor key: `succ ∥ prevHash(32B) ∥ slot(8B BE) ∥ hash(32B)`. Value
 *  is always the empty `Uint8Array` — the child hash is already in the
 *  key, so we save the round-trip on read. */
export const successorKey = (
  prevHash: Uint8Array,
  slot: bigint,
  hash: Uint8Array,
): Uint8Array => concat(PREFIX_SUCC, prevHash, be64(slot), hash);

/** Prefix for `BlobStore.scan(...)` to enumerate the successors of
 *  `parentHash`. Returns `succ ∥ parentHash` (36 bytes). */
export const successorPrefix = (parentHash: Uint8Array): Uint8Array =>
  concat(PREFIX_SUCC, parentHash);

/** Extract the child hash from a successor key. The hash sits at byte
 *  offset 4+32+8 = 44 and runs to byte offset 76. */
export const decodeSuccessorHash = (key: Uint8Array): Uint8Array => key.subarray(44, 76);

/** Extract the child slot from a successor key. The slot sits at byte
 *  offset 4+32 = 36 and runs to byte offset 44. */
export const decodeSuccessorSlot = (key: Uint8Array): bigint =>
  new DataView(key.buffer, key.byteOffset + 36, 8).getBigUint64(0);

// ────────────────────────────────────────────────────────────────────────────
// Tip pointers — `vtip` / `itip` singletons.
// ────────────────────────────────────────────────────────────────────────────

/** Volatile tip pointer key — `vtip ∥ 0x00`. */
export const volatileTipKey = (): Uint8Array => concat(PREFIX_VTIP, SENTINEL);

/** Immutable tip pointer key — `itip ∥ 0x00`. */
export const immutableTipKey = (): Uint8Array => concat(PREFIX_ITIP, SENTINEL);

/** Tip-value byte layout: `slot(8B BE) ∥ hash(32B)` = 40 bytes. */
export const encodeTipValue = (slot: bigint, hash: Uint8Array): Uint8Array =>
  concat(be64(slot), hash);

/** Inverse of `encodeTipValue`. */
export const decodeTipValue = (
  value: Uint8Array,
): { readonly slot: bigint; readonly hash: Uint8Array } => ({
  slot: new DataView(value.buffer, value.byteOffset, 8).getBigUint64(0),
  hash: value.subarray(8, 40),
});

// ────────────────────────────────────────────────────────────────────────────
// LedgerSnapshotStore keys — `smet` (snapshot metadata) + `nnce` (nonces).
// The blob payload itself stays under `snap:` (lsm-ffi `snapshotKey(slot)`).
// ────────────────────────────────────────────────────────────────────────────

/** Snapshot metadata prefix — `smet`. Suffix: `slot(8B BE)`. Value:
 *  `hash(32B) ∥ epoch(8B BE)` = 40 bytes. The state-bytes blob lives
 *  separately under `snap:{slot}` so a metadata-only listing doesn't
 *  fault-in 50 MB of CBOR. */
export const PREFIX_SMET = TEXT_ENCODER.encode("smet");

/** Snapshot metadata key — `smet ∥ slot(8B BE)`. */
export const snapshotMetaKey = (slot: bigint): Uint8Array => concat(PREFIX_SMET, be64(slot));

/** Snapshot metadata value: `hash(32B) ∥ epoch(8B BE)` = 40 bytes. */
export const encodeSnapshotMeta = (hash: Uint8Array, epoch: bigint): Uint8Array =>
  concat(hash, be64(epoch));

/** Inverse of `encodeSnapshotMeta`. */
export const decodeSnapshotMeta = (
  value: Uint8Array,
): { readonly hash: Uint8Array; readonly epoch: bigint } => ({
  hash: value.subarray(0, 32),
  epoch: new DataView(value.buffer, value.byteOffset + 32, 8).getBigUint64(0),
});

/** Decode `slot` from a `smet` key (8 bytes after the 4-byte prefix). */
export const decodeSnapshotMetaSlot = (key: Uint8Array): bigint =>
  new DataView(key.buffer, key.byteOffset + 4, 8).getBigUint64(0);

/** Praos nonce-triple prefix — `nnce`. Suffix: `epoch(8B BE)`. Value:
 *  `active(32B) ∥ evolving(32B) ∥ candidate(32B)` = 96 bytes. One row
 *  per epoch boundary; consumers `read` the latest by scanning the
 *  prefix and picking the max-epoch key. */
export const PREFIX_NNCE = TEXT_ENCODER.encode("nnce");

/** Nonces key — `nnce ∥ epoch(8B BE)`. */
export const noncesKey = (epoch: bigint): Uint8Array => concat(PREFIX_NNCE, be64(epoch));

/** Nonces value: `active(32B) ∥ evolving(32B) ∥ candidate(32B)`. */
export const encodeNoncesValue = (
  active: Uint8Array,
  evolving: Uint8Array,
  candidate: Uint8Array,
): Uint8Array => concat(active, evolving, candidate);

/** Inverse of `encodeNoncesValue`. */
export const decodeNoncesValue = (
  value: Uint8Array,
): {
  readonly active: Uint8Array;
  readonly evolving: Uint8Array;
  readonly candidate: Uint8Array;
} => ({
  active: value.subarray(0, 32),
  evolving: value.subarray(32, 64),
  candidate: value.subarray(64, 96),
});

/** Decode `epoch` from a `nnce` key. */
export const decodeNoncesEpoch = (key: Uint8Array): bigint =>
  new DataView(key.buffer, key.byteOffset + 4, 8).getBigUint64(0);

// ────────────────────────────────────────────────────────────────────────────
// Hash-to-slot inverted index — `vbyh` (volatile) / `ibyh` (immutable).
// `getBlock(hash)` needs to resolve a 32-byte hash to a slot without
// scanning all metadata keys. Each `addBlock` writes both a `*meta` row
// (slot,hash → meta) and a `*byh` row (hash → slot) so a hash-only
// lookup is two O(log n) gets instead of an O(n) scan.
// ────────────────────────────────────────────────────────────────────────────

/** Volatile by-hash index prefix — `vbyh`. Suffix: `hash(32B)`. Value: `slot(8B BE)`. */
export const PREFIX_VBYH = TEXT_ENCODER.encode("vbyh");

/** Immutable by-hash index prefix — `ibyh`. Suffix: `hash(32B)`. Value: `slot(8B BE)`. */
export const PREFIX_IBYH = TEXT_ENCODER.encode("ibyh");

/** Volatile by-hash key — `vbyh ∥ hash(32B)`. */
export const volatileByHashKey = (hash: Uint8Array): Uint8Array => concat(PREFIX_VBYH, hash);

/** Immutable by-hash key — `ibyh ∥ hash(32B)`. */
export const immutableByHashKey = (hash: Uint8Array): Uint8Array => concat(PREFIX_IBYH, hash);

/** By-hash value: `slot(8B BE)`. */
export const encodeByHashValue = (slot: bigint): Uint8Array => be64(slot);

/** Inverse of `encodeByHashValue`. */
export const decodeByHashValue = (value: Uint8Array): bigint =>
  new DataView(value.buffer, value.byteOffset, 8).getBigUint64(0);
