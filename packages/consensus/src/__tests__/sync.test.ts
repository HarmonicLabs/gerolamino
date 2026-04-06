import { describe, it, expect } from "vitest";
import { Clock, Effect, Layer, Stream } from "effect";
import { processBlock, getSyncState, syncFromStream } from "../sync";
import { Nonces } from "../nonce";
import { ConsensusEngineWithBunCrypto } from "../consensus-engine";
import { SlotClock, SlotClockLive, SlotConfig } from "../clock";
import { ImmutableDB, VolatileDB, LedgerDB } from "storage/services/index";
import type { BlockHeader, LedgerView } from "../validate-header";
import type { StoredBlock } from "storage/types/StoredBlock";

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const poolIdFromVk = (vk: Uint8Array): string => {
  const hasher = new Bun.CryptoHasher("blake2b256");
  return hex(new Uint8Array(hasher.update(vk).digest().buffer));
};

const makeVk = (seed: number): Uint8Array => {
  const vk = new Uint8Array(32);
  vk[0] = seed;
  return vk;
};

const makeBlock = (slot: bigint, blockNo: bigint): StoredBlock => ({
  slot,
  blockNo,
  hash: new Uint8Array(32).fill(Number(slot & 0xffn)),
  prevHash: new Uint8Array(32),
  blockSizeBytes: 256,
  blockCbor: new Uint8Array(256),
});

const makeHeader = (slot: bigint, blockNo: bigint): BlockHeader => {
  const issuerVk = makeVk(1);
  return {
    slot, blockNo,
    hash: new Uint8Array(32).fill(Number(slot & 0xffn)),
    prevHash: new Uint8Array(32),
    issuerVk, vrfVk: makeVk(2),
    vrfProof: new Uint8Array(80), vrfOutput: new Uint8Array(32).fill(Number(slot & 0xffn)),
    kesSig: new Uint8Array(448), kesPeriod: 10,
    opcertSig: new Uint8Array(64), opcertVkHot: new Uint8Array(32),
    opcertSeqNo: 5, opcertKesPeriod: 5,
    bodyHash: new Uint8Array(32),
  };
};

const makeLedgerView = (): LedgerView => {
  const poolId = poolIdFromVk(makeVk(1));
  return {
    epochNonce: new Uint8Array(32),
    poolVrfKeys: new Map([[poolId, makeVk(2)]]),
    poolStake: new Map([[poolId, 1_000_000n]]),
    totalStake: 10_000_000n,
    activeSlotsCoeff: 0.05,
    maxKesEvolutions: 62,
  };
};

// For sync tests, provide stub ImmutableDB/VolatileDB/LedgerDB directly
// (bypassing SQL, using only BlobStore)
const stubImmutableDb = Layer.succeed(ImmutableDB, {
  appendBlock: (_block: StoredBlock) => Effect.void,
  readBlock: (_point: { slot: bigint; hash: Uint8Array }) => Effect.succeed(undefined),
  getTip: Effect.succeed(undefined),
  streamBlocks: (_from: bigint, _to: bigint) => Stream.empty,
});

const stubVolatileDb = Layer.succeed(VolatileDB, {
  addBlock: (_block: StoredBlock) => Effect.void,
  getBlock: (_hash: Uint8Array) => Effect.succeed(undefined),
  getSuccessors: (_hash: Uint8Array) => Effect.succeed([]),
  garbageCollect: (_belowSlot: number) => Effect.void,
});

const stubLedgerDb = Layer.succeed(LedgerDB, {
  writeSnapshot: () => Effect.void,
  readLatestSnapshot: Effect.succeed(undefined),
});

// SlotClock with test config: system start at 0, 1s slots, 100 slots/epoch
const testConfig = new SlotConfig({
  systemStartMs: 0,
  slotLengthMs: 1000,
  epochLength: 100n,
  securityParam: 10,
  activeSlotsCoeff: 0.5,
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

const testLayers = Layer.mergeAll(
  ConsensusEngineWithBunCrypto,
  stubImmutableDb,
  stubVolatileDb,
  stubSlotClock,
  stubLedgerDb,
);

describe("Sync pipeline", () => {
  it("getSyncState returns initial state", async () => {
    const state = await Effect.runPromise(
      getSyncState.pipe(Effect.provide(testLayers)),
    );
    expect(state.tip).toBeUndefined();
    expect(state.blocksProcessed).toBe(0);
    expect(state.gsmState).toBe("Syncing");
  });

  it("processBlock validates and stores a block", async () => {
    const nonces = new Nonces({
      active: new Uint8Array(32),
      evolving: new Uint8Array(32),
      candidate: new Uint8Array(32),
      epoch: 0n,
    });

    const result = await Effect.runPromise(
      processBlock(
        makeBlock(100n, 50n),
        makeHeader(100n, 50n),
        makeLedgerView(),
        nonces,
      ).pipe(Effect.provide(testLayers)),
    );

    // Nonces should have been evolved
    expect(result.evolving).not.toEqual(nonces.evolving);
    expect(result.epoch).toBe(0n);
  });

  it("syncFromStream processes multiple blocks", async () => {
    const blocks = Stream.fromIterable(
      Array.from({ length: 10 }, (_, i) => ({
        block: makeBlock(BigInt(100 + i), BigInt(50 + i)),
        header: makeHeader(BigInt(100 + i), BigInt(50 + i)),
        ledgerView: makeLedgerView(),
      })),
    );

    const state = await Effect.runPromise(
      syncFromStream(blocks).pipe(Effect.provide(testLayers)),
    );

    expect(state.blocksProcessed).toBe(10);
    expect(state.tip?.slot).toBe(109n);
  });

  it("nonces evolve differently for each block", async () => {
    const nonces = new Nonces({
      active: new Uint8Array(32),
      evolving: new Uint8Array(32),
      candidate: new Uint8Array(32),
      epoch: 0n,
    });

    const nonces1 = await Effect.runPromise(
      processBlock(makeBlock(1n, 1n), makeHeader(1n, 1n), makeLedgerView(), nonces)
        .pipe(Effect.provide(testLayers)),
    );
    const nonces2 = await Effect.runPromise(
      processBlock(makeBlock(2n, 2n), makeHeader(2n, 2n), makeLedgerView(), nonces1)
        .pipe(Effect.provide(testLayers)),
    );

    expect(nonces1.evolving).not.toEqual(nonces.evolving);
    expect(nonces2.evolving).not.toEqual(nonces1.evolving);
  });
});
