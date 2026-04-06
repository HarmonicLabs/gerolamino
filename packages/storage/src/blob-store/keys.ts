/**
 * Prefix key constructors for the Amaru-inspired 4-byte prefix organization.
 * All keys start with a fixed prefix for efficient LSM/IndexedDB range scans.
 */

const encoder = new TextEncoder();

const PREFIX_UTXO = encoder.encode("utxo"); // 4 bytes
const PREFIX_BLK = encoder.encode("blk:"); // 4 bytes
const PREFIX_BIDX = encoder.encode("bidx"); // 4 bytes
const PREFIX_STAK = encoder.encode("stak"); // 4 bytes
const PREFIX_ACCT = encoder.encode("acct"); // 4 bytes
const PREFIX_COFF = encoder.encode("coff"); // 4 bytes

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
};

/** Encode a bigint as 8-byte big-endian. */
const be64 = (n: bigint): Uint8Array => {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, n);
  return buf;
};

/** Encode a number as 2-byte big-endian. */
const be16 = (n: number): Uint8Array => {
  const buf = new Uint8Array(2);
  const view = new DataView(buf.buffer);
  view.setUint16(0, n);
  return buf;
};

/** UTxO key: `utxo` + TxIn (34B MemPack: 32B txId + 2B LE index). */
export const utxoKey = (txIn: Uint8Array): Uint8Array =>
  concat(PREFIX_UTXO, txIn);

/** Block blob key: `blk:` + slot (8B BE) + hash (32B). */
export const blockKey = (slot: bigint, hash: Uint8Array): Uint8Array =>
  concat(PREFIX_BLK, be64(slot), hash);

/** Block index key: `bidx` + blockNo (8B BE). */
export const blockIndexKey = (blockNo: bigint): Uint8Array =>
  concat(PREFIX_BIDX, be64(blockNo));

/** Stake distribution key: `stak` + pool_hash (28B). */
export const stakeKey = (poolHash: Uint8Array): Uint8Array =>
  concat(PREFIX_STAK, poolHash);

/** Account key: `acct` + stake_addr (28B). */
export const accountKey = (stakeAddr: Uint8Array): Uint8Array =>
  concat(PREFIX_ACCT, stakeAddr);

/** CBOR offset key: `coff` + slot (8B BE) + tx_idx (2B BE). */
export const cborOffsetKey = (slot: bigint, txIdx: number): Uint8Array =>
  concat(PREFIX_COFF, be64(slot), be16(txIdx));

/** Compute the exclusive upper bound for a prefix scan (increment last byte). */
export const prefixEnd = (prefix: Uint8Array): Uint8Array => {
  const end = new Uint8Array(prefix);
  for (let i = end.length - 1; i >= 0; i--) {
    if (end[i]! < 0xff) {
      end[i]!++;
      return end.subarray(0, i + 1);
    }
  }
  // All 0xFF — no upper bound (scan to end)
  return new Uint8Array(0);
};

export {
  PREFIX_UTXO,
  PREFIX_BLK,
  PREFIX_BIDX,
  PREFIX_STAK,
  PREFIX_ACCT,
  PREFIX_COFF,
};
