import { describe, it, expect } from "@effect/vitest";
import { Clock, Effect, HashMap, Layer, Option, Stream } from "effect";
import { processBlock, getSyncState, syncFromStream } from "../sync/bootstrap";
import { Nonces } from "../praos/nonce";
import { CryptoStub } from "./crypto-stub";
import { SlotClock, SlotClockLive, SlotConfig } from "../praos/clock";
import { ChainDB, LedgerSnapshotStore } from "storage";
import type { StoredBlock } from "storage";
import { concat } from "../util";
import { encodeSync, CborKinds } from "codecs";
import type { CborSchemaType } from "codecs";
import type { BlockHeader, LedgerView } from "../validate/header";

const poolIdFromVk = (vk: Uint8Array): string => {
  const hasher = new Bun.CryptoHasher("blake2b256");
  return new Uint8Array(hasher.update(vk).digest().buffer).toHex();
};

const makeVk = (seed: number): Uint8Array => {
  const vk = new Uint8Array(32);
  vk[0] = seed;
  return vk;
};

// Shared empty body components for constructing valid block CBOR
const emptyArray: CborSchemaType = { _tag: CborKinds.Array, items: [] };
const emptyMap: CborSchemaType = { _tag: CborKinds.Map, entries: [] };

/** Compute body hash from empty block body (double-hash Merkle scheme per spec). */
const emptyBodyHash = (() => {
  const hash = (data: Uint8Array): Uint8Array => {
    const h = new Bun.CryptoHasher("blake2b256");
    return new Uint8Array(h.update(data).digest().buffer);
  };
  const segHashes = concat(
    hash(encodeSync(emptyArray)), // txBodies
    hash(encodeSync(emptyArray)), // witnesses
    hash(encodeSync(emptyMap)), // auxData
    hash(encodeSync(emptyArray)), // invalidTxs
  );
  return hash(segHashes);
})();

/** Build valid Shelley+ block CBOR with empty body (era 6 = Conway). */
const makeBlockCbor = (): Uint8Array => {
  const header: CborSchemaType = {
    _tag: CborKinds.Array,
    items: [{ _tag: CborKinds.UInt, num: 0n }],
  };
  const block: CborSchemaType = {
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.UInt, num: 6n },
      { _tag: CborKinds.Array, items: [header, emptyArray, emptyArray, emptyMap, emptyArray] },
    ],
  };
  return encodeSync(block);
};

const validBlockCbor = makeBlockCbor();

const makeBlock = (slot: bigint, blockNo: bigint): StoredBlock => ({
  slot,
  blockNo,
  hash: new Uint8Array(32).fill(Number(slot & 0xffn)),
  prevHash: new Uint8Array(32),
  blockSizeBytes: validBlockCbor.byteLength,
  blockCbor: validBlockCbor,
});

const makeHeader = (slot: bigint, blockNo: bigint): BlockHeader => {
  const issuerVk = makeVk(1);
  return {
    slot,
    blockNo,
    hash: new Uint8Array(32).fill(Number(slot & 0xffn)),
    prevHash: new Uint8Array(32),
    issuerVk,
    vrfVk: makeVk(2),
    vrfProof: new Uint8Array(80),
    vrfOutput: new Uint8Array(32).fill(Number(slot & 0xffn)),
    nonceVrfOutput: new Uint8Array(32).fill(Number(slot & 0xffn)),
    kesSig: new Uint8Array(448),
    kesPeriod: 10,
    opcertSig: new Uint8Array(64),
    opcertVkHot: new Uint8Array(32),
    opcertSeqNo: 5,
    opcertKesPeriod: 5,
    bodyHash: emptyBodyHash,
    bodySize: 0,
    headerBodyCbor: new Uint8Array(32),
  };
};

const makeLedgerView = (): LedgerView => {
  const poolId = poolIdFromVk(makeVk(1));
  return {
    epochNonce: new Uint8Array(32),
    poolVrfKeys: HashMap.make([poolId, makeVk(2)]),
    poolStake: HashMap.make([poolId, 1_000_000n]),
    totalStake: 10_000_000n,
    activeSlotsCoeff: 0.05,
    maxKesEvolutions: 62,
    maxHeaderSize: 0,
    maxBlockBodySize: 0,
    ocertCounters: HashMap.empty(),
  };
};

// Stub ChainDB + LedgerSnapshotStore for sync tests (in-memory, no SQL/BlobStore)
const stubChainDb = Layer.succeed(ChainDB, {
  getBlock: () => Effect.succeed(Option.none()),
  getBlockAt: () => Effect.succeed(Option.none()),
  getTip: Effect.succeed(Option.none()),
  getImmutableTip: Effect.succeed(Option.none()),
  addBlock: () => Effect.void,
  rollback: () => Effect.void,
  getSuccessors: () => Effect.succeed([]),
  streamFrom: () => Stream.empty,
  promoteToImmutable: () => Effect.void,
  garbageCollect: () => Effect.void,
  writeBlobEntries: () => Effect.void,
  deleteBlobEntries: () => Effect.void,
});

const stubLedgerSnapshots = Layer.succeed(LedgerSnapshotStore, {
  writeLedgerSnapshot: () => Effect.void,
  readLatestLedgerSnapshot: Effect.succeed(Option.none()),
  writeNonces: () => Effect.void,
  readNonces: Effect.succeed(Option.none()),
});

// SlotClock with test config: system start at 0, 1s slots, 100 slots/epoch
const testConfig = new SlotConfig({
  systemStartMs: 0,
  slotLengthMs: 1000,
  epochLength: 100n,
  securityParam: 10,
  activeSlotsCoeff: 0.5,
  byronEpochLength: 4320n,
});
const fixedClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => 200_000, // slot 200
  currentTimeMillis: Effect.sync(() => 200_000),
  currentTimeNanosUnsafe: () => 200_000_000_000n,
  currentTimeNanos: Effect.sync(() => 200_000_000_000n),
  sleep: () => Effect.void,
};
const stubSlotClock = Layer.effect(
  SlotClock,
  SlotClockLive(testConfig).pipe(Effect.provideService(Clock.Clock, fixedClock)),
);

const testLayers = Layer.mergeAll(CryptoStub, stubChainDb, stubLedgerSnapshots, stubSlotClock);

describe("Sync pipeline", () => {
  it.effect("getSyncState returns initial state", () =>
    Effect.gen(function* () {
      const state = yield* getSyncState;
      expect(state.tip).toBeUndefined();
      expect(state.blocksProcessed).toBe(0);
      expect(state.gsmState).toBe("Syncing");
    }).pipe(Effect.provide(testLayers)),
  );

  it.effect("processBlock validates and stores a block", () =>
    Effect.gen(function* () {
      const nonces = new Nonces({
        active: new Uint8Array(32),
        evolving: new Uint8Array(32),
        candidate: new Uint8Array(32),
        epoch: 0n,
      });

      // Slot 50 stays within epoch 0 (epochLength=100)
      const result = yield* processBlock(
        makeBlock(50n, 25n),
        makeHeader(50n, 25n),
        makeLedgerView(),
        nonces,
      );

      // Nonces should have been evolved
      expect(result.evolving).not.toEqual(nonces.evolving);
      expect(result.epoch).toBe(0n);
    }).pipe(Effect.provide(testLayers)),
  );

  it.effect("syncFromStream processes multiple blocks", () =>
    Effect.gen(function* () {
      const blocks = Stream.fromIterable(
        Array.from({ length: 10 }, (_, i) => ({
          block: makeBlock(BigInt(100 + i), BigInt(50 + i)),
          header: makeHeader(BigInt(100 + i), BigInt(50 + i)),
          ledgerView: makeLedgerView(),
        })),
      );

      const state = yield* syncFromStream(blocks);

      expect(state.blocksProcessed).toBe(10);
      expect(state.tip?.slot).toBe(109n);
    }).pipe(Effect.provide(testLayers)),
  );

  it.effect("epoch transition derives new nonce at epoch boundary", () =>
    Effect.gen(function* () {
      const nonces = new Nonces({
        active: new Uint8Array(32).fill(0xaa),
        evolving: new Uint8Array(32).fill(0xbb),
        candidate: new Uint8Array(32).fill(0xcc),
        epoch: 0n,
      });

      // Slot 100 is in epoch 1 (epochLength=100), so epoch transition triggers
      const result = yield* processBlock(
        makeBlock(100n, 50n),
        makeHeader(100n, 50n),
        makeLedgerView(),
        nonces,
      );

      // Epoch should advance
      expect(result.epoch).toBe(1n);
      // Active nonce should change (derived from candidate + prevHash)
      expect(result.active.toHex()).not.toBe(nonces.active.toHex());
      // Active should not be the old candidate verbatim — it's blake2b(candidate ∥ prevHash)
      expect(result.active.toHex()).not.toBe(nonces.candidate.toHex());
    }).pipe(Effect.provide(testLayers)),
  );

  it.effect("epoch transition does not fire within same epoch", () =>
    Effect.gen(function* () {
      const nonces = new Nonces({
        active: new Uint8Array(32).fill(0xaa),
        evolving: new Uint8Array(32).fill(0xbb),
        candidate: new Uint8Array(32).fill(0xcc),
        epoch: 0n,
      });

      // Slot 50 is still epoch 0 (epochLength=100)
      const result = yield* processBlock(
        makeBlock(50n, 25n),
        makeHeader(50n, 25n),
        makeLedgerView(),
        nonces,
      );

      // Active nonce unchanged — no epoch transition
      expect(result.active.toHex()).toBe(nonces.active.toHex());
      expect(result.epoch).toBe(0n);
    }).pipe(Effect.provide(testLayers)),
  );

  it.effect("nonces evolve differently for each block", () =>
    Effect.gen(function* () {
      const nonces = new Nonces({
        active: new Uint8Array(32),
        evolving: new Uint8Array(32),
        candidate: new Uint8Array(32),
        epoch: 0n,
      });

      const nonces1 = yield* processBlock(
        makeBlock(1n, 1n),
        makeHeader(1n, 1n),
        makeLedgerView(),
        nonces,
      );
      const nonces2 = yield* processBlock(
        makeBlock(2n, 2n),
        makeHeader(2n, 2n),
        makeLedgerView(),
        nonces1,
      );

      expect(nonces1.evolving).not.toEqual(nonces.evolving);
      expect(nonces2.evolving).not.toEqual(nonces1.evolving);
    }).pipe(Effect.provide(testLayers)),
  );
});
