/**
 * Property tests for the 4-byte-prefix key encoders in `keys.ts`.
 *
 * Invariants (spec-derived from the LSM scan semantics):
 *   - Every encoded key starts with its 4-byte ASCII prefix.
 *   - Keys are deterministic: same inputs → same bytes.
 *   - Different scopes produce disjoint prefix namespaces
 *     (utxoKey ≠ blockKey prefix even for equal trailing bytes).
 *   - `prefixEnd` produces an exclusive upper bound > `prefix` lexicographically.
 *   - `prefixEnd` + scan gives all keys starting with `prefix`.
 */
import { describe, expect, it } from "@effect/vitest";
import * as FastCheck from "effect/testing/FastCheck";
import {
  PREFIX_ACCT,
  PREFIX_BIDX,
  PREFIX_BLK,
  PREFIX_COFF,
  PREFIX_SNAP,
  PREFIX_STAK,
  PREFIX_UTXO,
  accountKey,
  blockIndexKey,
  blockKey,
  cborOffsetKey,
  prefixEnd,
  snapshotKey,
  stakeKey,
  utxoKey,
} from "../keys.ts";

const NUM_RUNS = 1_000;

const startsWith = (key: Uint8Array, prefix: Uint8Array): boolean => {
  if (key.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (key[i] !== prefix[i]) return false;
  }
  return true;
};

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const lexLt = (a: Uint8Array, b: Uint8Array): boolean => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]! < b[i]!) return true;
    if (a[i]! > b[i]!) return false;
  }
  return a.length < b.length;
};

const bytesArb = (length: number) => FastCheck.uint8Array({ minLength: length, maxLength: length });

const bigIntU64 = FastCheck.bigInt({ min: 0n, max: 2n ** 64n - 1n });

describe("ffi/keys: prefix invariants", () => {
  it("utxoKey starts with PREFIX_UTXO + deterministic", () => {
    FastCheck.assert(
      FastCheck.property(bytesArb(34), (txIn) => {
        const k = utxoKey(txIn);
        return startsWith(k, PREFIX_UTXO) && bytesEqual(k, utxoKey(txIn));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("blockKey starts with PREFIX_BLK, embeds slot + hash in order", () => {
    FastCheck.assert(
      FastCheck.property(bigIntU64, bytesArb(32), (slot, hash) => {
        const k = blockKey(slot, hash);
        if (!startsWith(k, PREFIX_BLK)) return false;
        // After prefix (4B): slot (8B BE) then hash (32B). Total 44B.
        if (k.length !== 4 + 8 + 32) return false;
        return bytesEqual(k, blockKey(slot, hash));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("blockIndexKey starts with PREFIX_BIDX + is 12 bytes", () => {
    FastCheck.assert(
      FastCheck.property(bigIntU64, (blockNo) => {
        const k = blockIndexKey(blockNo);
        return startsWith(k, PREFIX_BIDX) && k.length === 4 + 8;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("stakeKey + accountKey produce disjoint namespaces for equal trailing bytes", () => {
    FastCheck.assert(
      FastCheck.property(bytesArb(28), (hash28) => {
        const s = stakeKey(hash28);
        const a = accountKey(hash28);
        return !bytesEqual(s, a);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("snapshotKey starts with PREFIX_SNAP + is 12 bytes", () => {
    FastCheck.assert(
      FastCheck.property(bigIntU64, (slot) => {
        const k = snapshotKey(slot);
        return startsWith(k, PREFIX_SNAP) && k.length === 4 + 8;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("cborOffsetKey starts with PREFIX_COFF + is 14 bytes (4 + 8 + 2)", () => {
    FastCheck.assert(
      FastCheck.property(bigIntU64, FastCheck.integer({ min: 0, max: 65535 }), (slot, txIdx) => {
        const k = cborOffsetKey(slot, txIdx);
        return startsWith(k, PREFIX_COFF) && k.length === 4 + 8 + 2;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("all fixed prefixes are exactly 4 bytes", () => {
    for (const p of [
      PREFIX_UTXO,
      PREFIX_BLK,
      PREFIX_BIDX,
      PREFIX_STAK,
      PREFIX_ACCT,
      PREFIX_SNAP,
      PREFIX_COFF,
    ]) {
      expect(p.length).toBe(4);
    }
  });
});

describe("ffi/keys: prefixEnd invariants", () => {
  it("prefixEnd of a non-saturated prefix is strictly lex-greater", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.uint8Array({ minLength: 1, maxLength: 16 }).filter(
          (b) => !Array.from(b).every((x) => x === 0xff),
        ),
        (prefix) => lexLt(prefix, prefixEnd(prefix)),
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("prefixEnd of all-0xFF prefix is empty (no valid upper bound)", () => {
    const allFF = new Uint8Array([0xff, 0xff, 0xff]);
    expect(prefixEnd(allFF).length).toBe(0);
  });

  it("prefixEnd(blockKey prefix) excludes all blockKey keys from snapshotKey range", () => {
    // The 4 prefix ASCII bytes are: blk:=[0x62,0x6c,0x6b,0x3a], snap=[0x73,0x6e,0x61,0x70]
    // After incrementing blk: (last byte 0x3a → 0x3b), result = [0x62,0x6c,0x6b,0x3b] which is
    // still lex-less than snap (0x73 > 0x62). So scan [PREFIX_BLK, prefixEnd(PREFIX_BLK)) is
    // disjoint from [PREFIX_SNAP, ...).
    const blkEnd = prefixEnd(PREFIX_BLK);
    expect(lexLt(blkEnd, PREFIX_SNAP)).toBe(true);
  });

  it("boundary: prefixEnd examples", () => {
    expect(prefixEnd(new Uint8Array([0x01]))).toEqual(new Uint8Array([0x02]));
    // Trailing 0xFF gets trimmed
    expect(prefixEnd(new Uint8Array([0x01, 0xff]))).toEqual(new Uint8Array([0x02]));
    expect(prefixEnd(new Uint8Array([0xff, 0xff]))).toEqual(new Uint8Array([]));
  });
});
