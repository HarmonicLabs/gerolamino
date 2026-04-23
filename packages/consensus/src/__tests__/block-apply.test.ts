import { describe, it, expect } from "@effect/vitest";
import { encodeSync, CborKinds } from "codecs";
import type { CborSchemaType } from "codecs";
import { applyBlock } from "../validate/apply";

// ---------------------------------------------------------------------------
// Test helpers — build minimal block CBOR with real structure
// ---------------------------------------------------------------------------

const uint = (n: bigint | number): CborSchemaType => ({ _tag: CborKinds.UInt, num: BigInt(n) });
const bytes = (b: Uint8Array): CborSchemaType => ({ _tag: CborKinds.Bytes, bytes: b });
const arr = (...items: CborSchemaType[]): CborSchemaType => ({ _tag: CborKinds.Array, items });
const map = (...entries: [CborSchemaType, CborSchemaType][]): CborSchemaType => ({
  _tag: CborKinds.Map,
  entries: entries.map(([k, v]) => ({ k, v })),
});
const tag258 = (inner: CborSchemaType): CborSchemaType => ({
  _tag: CborKinds.Tag,
  tag: 258n,
  data: inner,
});

/** Build a minimal valid post-Byron block CBOR that analyzeBlockCbor can navigate. */
const makeBlock = (
  era: number,
  txBodies: CborSchemaType,
  invalidTxs?: CborSchemaType,
): Uint8Array => {
  // Header: [[blockNo, slot, ...rest], kesSig]
  const headerBody = arr(uint(1), uint(100), bytes(new Uint8Array(32)), bytes(new Uint8Array(32)));
  const header = arr(headerBody, bytes(new Uint8Array(32)));

  const bodyItems: CborSchemaType[] = [
    header,
    txBodies,
    arr(), // witnesses (empty)
    map(), // auxData (empty)
  ];
  if (invalidTxs) bodyItems.push(invalidTxs);

  return encodeSync(arr(uint(era), arr(...bodyItems)));
};

/** Build a TxIn CBOR: [txId_bytes32, index_uint] */
const makeTxIn = (txId: Uint8Array, index: number): CborSchemaType => arr(bytes(txId), uint(index));

/** Build a simple Shelley-era TxOut: [address_bytes, coin_uint] */
const makeTxOut = (addr: Uint8Array, coin: bigint): CborSchemaType => arr(bytes(addr), uint(coin));

/** Build a tx body map with given fields */
const makeTxBody = (fields: Record<number, CborSchemaType>): CborSchemaType =>
  map(
    ...Object.entries(fields).map(
      ([k, v]) => [uint(Number(k)), v] as [CborSchemaType, CborSchemaType],
    ),
  );

/** Stub pre-computed txIds — applyBlock now takes them as an argument (pure, no hasher). */
const makeTxIds = (n: number): readonly Uint8Array[] =>
  Array.from({ length: n }, (_, i) => {
    const id = new Uint8Array(32);
    id[0] = 0xf0 + i;
    return id;
  });

/** Known txId for test — hash of a specific tx body */
const knownTxId = new Uint8Array(32).fill(0xaa);
const addr1 = new Uint8Array(57).fill(0x01);
const addr2 = new Uint8Array(57).fill(0x02);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyBlock", () => {
  it("returns empty diff for Byron blocks", () => {
    const block = makeBlock(1, arr()); // era 1 = Byron
    const diff = applyBlock(block, makeTxIds(0));
    expect(diff.utxoInserts).toHaveLength(0);
    expect(diff.utxoDeletes).toHaveLength(0);
  });

  it("returns empty diff for blocks with no transactions", () => {
    const block = makeBlock(6, arr()); // era 6 = Conway, no txs
    const diff = applyBlock(block, makeTxIds(0));
    expect(diff.utxoInserts).toHaveLength(0);
    expect(diff.utxoDeletes).toHaveLength(0);
  });

  it("produces UTxO deletes for consumed inputs", () => {
    const txBody = makeTxBody({
      0: arr(makeTxIn(knownTxId, 0), makeTxIn(knownTxId, 1)), // 2 inputs
      1: arr(), // no outputs
      2: uint(200000), // fee
    });
    const block = makeBlock(6, arr(txBody));
    const diff = applyBlock(block, makeTxIds(1));

    expect(diff.utxoDeletes).toHaveLength(2);
    // Keys should start with "utxo" prefix (0x75747866)
    for (const key of diff.utxoDeletes) {
      expect(key[0]).toBe(0x75); // 'u'
      expect(key[1]).toBe(0x74); // 't'
      expect(key[2]).toBe(0x78); // 'x' -- note: utxo = 75 74 78 6f
    }
  });

  it("produces UTxO inserts for produced outputs", () => {
    const txBody = makeTxBody({
      0: arr(), // no inputs
      1: arr(makeTxOut(addr1, 5000000n), makeTxOut(addr2, 3000000n)), // 2 outputs
      2: uint(200000), // fee
    });
    const block = makeBlock(6, arr(txBody));
    const diff = applyBlock(block, makeTxIds(1));

    expect(diff.utxoInserts).toHaveLength(2);
    // Each insert key should be utxoKey(txId, index)
    // txId = stub txIds[0], index = 0 and 1
    for (const entry of diff.utxoInserts) {
      expect(entry.key[0]).toBe(0x75); // 'u' prefix
      expect(entry.value.byteLength).toBeGreaterThan(0);
    }
  });

  it("handles invalid tx — consumes collateral, not regular inputs", () => {
    const regularInput = makeTxIn(knownTxId, 0);
    const collateralInput = makeTxIn(knownTxId, 5);
    const txBody = makeTxBody({
      0: arr(regularInput), // regular inputs
      1: arr(makeTxOut(addr1, 5000000n)), // outputs
      2: uint(200000),
      13: arr(collateralInput), // collateral inputs
    });
    const block = makeBlock(6, arr(txBody), arr(uint(0))); // tx index 0 is invalid
    const diff = applyBlock(block, makeTxIds(1));

    // Regular inputs NOT consumed, collateral IS consumed
    expect(diff.utxoDeletes).toHaveLength(1);
    // Regular outputs NOT produced
    expect(diff.utxoInserts).toHaveLength(0);
  });

  it("handles collateral return for invalid tx (Babbage+)", () => {
    const collateralInput = makeTxIn(knownTxId, 5);
    const collateralReturn = makeTxOut(addr1, 4800000n);
    const txBody = makeTxBody({
      0: arr(), // regular inputs
      1: arr(makeTxOut(addr1, 5000000n), makeTxOut(addr2, 3000000n)), // 2 regular outputs
      2: uint(200000),
      13: arr(collateralInput),
      16: collateralReturn, // collateral return
    });
    const block = makeBlock(6, arr(txBody), arr(uint(0)));
    const diff = applyBlock(block, makeTxIds(1));

    expect(diff.utxoDeletes).toHaveLength(1); // collateral consumed
    expect(diff.utxoInserts).toHaveLength(1); // collateral return at index = len(outputs) = 2
  });

  it("processes StakeRegistration certificate", () => {
    const credHash = new Uint8Array(28).fill(0xcc);
    const credential: CborSchemaType = arr(uint(0), bytes(credHash)); // [0, keyhash]
    const cert = arr(uint(0), credential); // [0, credential] = StakeRegistration
    const txBody = makeTxBody({
      0: arr(),
      1: arr(),
      2: uint(200000),
      4: arr(cert),
    });
    const block = makeBlock(6, arr(txBody));
    const diff = applyBlock(block, makeTxIds(1));

    expect(diff.accountUpdates).toHaveLength(1);
    // Key should start with "acct" prefix (0x61636374)
    expect(diff.accountUpdates[0]!.key[0]).toBe(0x61); // 'a'
    expect(diff.accountUpdates[0]!.key[1]).toBe(0x63); // 'c'
    // Value is 73 bytes (account encoding)
    expect(diff.accountUpdates[0]!.value.byteLength).toBe(73);
  });

  it("processes StakeDeregistration certificate", () => {
    const credHash = new Uint8Array(28).fill(0xdd);
    const credential = arr(uint(0), bytes(credHash));
    const cert = arr(uint(1), credential); // [1, credential] = StakeDeregistration
    const txBody = makeTxBody({
      0: arr(),
      1: arr(),
      2: uint(200000),
      4: arr(cert),
    });
    const block = makeBlock(6, arr(txBody));
    const diff = applyBlock(block, makeTxIds(1));

    expect(diff.accountDeletes).toHaveLength(1);
    expect(diff.accountDeletes[0]![0]).toBe(0x61); // 'a' prefix
  });

  it("processes StakeDelegation certificate", () => {
    const credHash = new Uint8Array(28).fill(0xaa);
    const poolHash = new Uint8Array(28).fill(0xbb);
    const credential = arr(uint(0), bytes(credHash));
    const cert = arr(uint(2), credential, bytes(poolHash)); // StakeDelegation
    const txBody = makeTxBody({
      0: arr(),
      1: arr(),
      2: uint(200000),
      4: arr(cert),
    });
    const block = makeBlock(6, arr(txBody));
    const diff = applyBlock(block, makeTxIds(1));

    expect(diff.accountUpdates).toHaveLength(1);
    const val = diff.accountUpdates[0]!.value;
    // flags byte at offset 16: bit 0 set (pool delegation present)
    expect(val[16]! & 0x01).toBe(1);
    // poolHash at offset 17..45
    expect(val.subarray(17, 45)).toEqual(poolHash);
  });

  it("processes PoolRegistration certificate", () => {
    const operatorHash = new Uint8Array(28).fill(0xee);
    const cert = arr(
      uint(3), // PoolRegistration
      bytes(operatorHash), // operator
      bytes(new Uint8Array(32)), // vrfKeyhash
      uint(500000000), // pledge
      uint(340000000), // cost
      arr(uint(0), uint(1)), // margin (unit interval)
      bytes(new Uint8Array(29)), // reward account
      arr(), // pool owners
      arr(), // relays
    );
    const txBody = makeTxBody({
      0: arr(),
      1: arr(),
      2: uint(200000),
      4: arr(cert),
    });
    const block = makeBlock(6, arr(txBody));
    const diff = applyBlock(block, makeTxIds(1));

    expect(diff.stakeUpdates).toHaveLength(1);
    // Key should start with "stak" prefix (0x7374616b)
    expect(diff.stakeUpdates[0]!.key[0]).toBe(0x73); // 's'
    expect(diff.stakeUpdates[0]!.key[1]).toBe(0x74); // 't'
    // Value is 8 bytes (stake = 0)
    expect(diff.stakeUpdates[0]!.value.byteLength).toBe(8);
  });

  it("processes Conway tag-258 wrapped sets", () => {
    const txBody = makeTxBody({
      0: tag258(arr(makeTxIn(knownTxId, 0))), // Conway set-wrapped inputs
      1: arr(makeTxOut(addr1, 5000000n)),
      2: uint(200000),
    });
    const block = makeBlock(6, arr(txBody));
    const diff = applyBlock(block, makeTxIds(1));

    expect(diff.utxoDeletes).toHaveLength(1);
    expect(diff.utxoInserts).toHaveLength(1);
  });

  it("processes StakeVoteRegDeleg (tag 13) — full combined cert", () => {
    const credHash = new Uint8Array(28).fill(0x11);
    const poolHash = new Uint8Array(28).fill(0x22);
    const drepHash = new Uint8Array(28).fill(0x33);
    const credential = arr(uint(0), bytes(credHash));
    const drep = arr(uint(0), bytes(drepHash)); // keyHash drep
    const cert = arr(uint(13), credential, bytes(poolHash), drep, uint(2000000)); // StakeVoteRegDeleg
    const txBody = makeTxBody({
      0: arr(),
      1: arr(),
      2: uint(200000),
      4: arr(cert),
    });
    const block = makeBlock(6, arr(txBody));
    const diff = applyBlock(block, makeTxIds(1));

    expect(diff.accountUpdates).toHaveLength(1);
    const val = diff.accountUpdates[0]!.value;
    // flags: bit 0 = pool present (1), bits 1-3 = drep kind 1 (keyHash) -> 0b010 << 1 = 2
    expect(val[16]).toBe(1 | (1 << 1)); // = 3
    expect(val.subarray(17, 45)).toEqual(poolHash);
    expect(val.subarray(45, 73)).toEqual(drepHash);
    // deposit at offset 8..16
    const deposit = new DataView(val.buffer).getBigUint64(8, false);
    expect(deposit).toBe(2000000n);
  });

  it("processes multiple transactions in one block", () => {
    const tx1 = makeTxBody({
      0: arr(makeTxIn(knownTxId, 0)),
      1: arr(makeTxOut(addr1, 5000000n)),
      2: uint(200000),
    });
    const tx2 = makeTxBody({
      0: arr(makeTxIn(knownTxId, 1)),
      1: arr(makeTxOut(addr2, 3000000n), makeTxOut(addr1, 1000000n)),
      2: uint(200000),
    });
    const block = makeBlock(6, arr(tx1, tx2));
    const diff = applyBlock(block, makeTxIds(2));

    expect(diff.utxoDeletes).toHaveLength(2); // 1 input per tx
    expect(diff.utxoInserts).toHaveLength(3); // 1 + 2 outputs
  });
});
