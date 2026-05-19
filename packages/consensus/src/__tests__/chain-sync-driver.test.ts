import { describe, expect, it, layer } from "@effect/vitest";
import { Clock, Effect, HashMap, Layer, Option, Stream } from "effect";
import { encodeSync, CborKinds, type CborSchemaType } from "codecs";
import { handleRollForward, handleRollBackward, initialVolatileState } from "../sync/driver";
import { CryptoStub } from "./crypto-stub";
import { PeerManager, PeerManagerLive } from "../peer/manager";
import { SlotClock, SlotClockLive, SlotConfig } from "../praos/clock";
import { ChainDB, LedgerSnapshotStore } from "storage";
import { Nonces } from "../praos/nonce";
import type { LedgerView } from "../validate/header";
// `handleRollForward` / `handleRollBackward` emit durable chain events via
// `writeChainEvent` (BlockAccepted / TipAdvanced / RolledBack / EpochBoundary),
// so the test harness must provide an `EventLog` instance — `ChainEventsLive`
// is the canonical memory-journal-backed composition (same one used by
// `stage-eventlog-integration.test.ts`).
import { ChainEventsLive } from "../chain/event-log";

const testConfig = new SlotConfig({
  systemStartMs: 0,
  slotLengthMs: 1000,
  epochLength: 100n,
  securityParam: 10,
  activeSlotsCoeff: 0.5,
  byronEpochLength: 4320n,
});

const fixedClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => 500_000,
  currentTimeMillis: Effect.sync(() => 500_000),
  currentTimeNanosUnsafe: () => 500_000_000_000n,
  currentTimeNanos: Effect.sync(() => 500_000_000_000n),
  sleep: () => Effect.void,
};

const slotClockLayer = Layer.effect(
  SlotClock,
  SlotClockLive(testConfig).pipe(Effect.provideService(Clock.Clock, fixedClock)),
);

const peerManagerLayer = Layer.effect(PeerManager, PeerManagerLive).pipe(
  Layer.provide(slotClockLayer),
);

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

const testLayers = Layer.mergeAll(
  CryptoStub,
  stubLedgerSnapshots,
  slotClockLayer,
  peerManagerLayer,
  stubChainDb,
  ChainEventsLive,
);

/**
 * Build a minimal Babbage-era header CBOR: [headerBody(10 elements), kesSig].
 * This is the format AFTER ChainSync schema extraction (era wrapper + Tag(24) already stripped).
 * Pass eraVariant=5 (Babbage) when calling handleRollForward.
 */
const makeBabbageHeader = (
  slot: bigint,
  blockNo: bigint,
  issuerVk: Uint8Array,
  vrfVk?: Uint8Array,
  prevHashBytes?: Uint8Array,
): Uint8Array => {
  const uint = (n: bigint): CborSchemaType => ({ _tag: CborKinds.UInt, num: n });
  const bytes = (b: Uint8Array): CborSchemaType => ({ _tag: CborKinds.Bytes, bytes: b });
  const arr = (...items: CborSchemaType[]): CborSchemaType => ({ _tag: CborKinds.Array, items });

  const vrf = vrfVk ?? new Uint8Array(32);
  const vrfOutput = new Uint8Array(32);
  const vrfProof = new Uint8Array(80);
  const prevHash = prevHashBytes ?? new Uint8Array(32);
  const bodyHash = new Uint8Array(32);
  const hotVKey = new Uint8Array(32);
  const opcertSig = new Uint8Array(64);
  const kesSig = new Uint8Array(448); // Sum6 KES sig

  const headerBody = arr(
    uint(blockNo), // [0] blockNo
    uint(slot), // [1] slot
    bytes(prevHash), // [2] prevHash
    bytes(issuerVk), // [3] issuerVKey
    bytes(vrf), // [4] vrfVKey
    arr(bytes(vrfOutput), bytes(vrfProof)), // [5] vrfResult
    uint(100n), // [6] bodySize
    bytes(bodyHash), // [7] bodyHash
    arr(bytes(hotVKey), uint(0n), uint(0n), bytes(opcertSig)), // [8] opCert
    arr(uint(9n), uint(0n)), // [9] protVer
  );

  return encodeSync(arr(headerBody, bytes(kesSig)));
};

/** N2N era variant for Babbage (used with handleRollForward). */
const BABBAGE_ERA_VARIANT = 5;

const poolIdFromVk = (vk: Uint8Array): string => {
  const hasher = new Bun.CryptoHasher("blake2b256");
  return new Uint8Array(hasher.update(vk).digest().buffer).toHex();
};

const TEST_ISSUER_VK = (() => {
  const vk = new Uint8Array(32);
  vk[0] = 1;
  return vk;
})();
const TEST_VRF_VK = (() => {
  const vk = new Uint8Array(32);
  vk[0] = 2;
  return vk;
})();

const makeLedgerView = (): LedgerView => {
  const poolId = poolIdFromVk(TEST_ISSUER_VK);
  return {
    epochNonce: new Uint8Array(32),
    poolVrfKeys: HashMap.make([poolId, TEST_VRF_VK]),
    poolStake: HashMap.make([poolId, 1_000_000n]),
    totalStake: 10_000_000n,
    activeSlotsCoeff: 0.05,
    maxKesEvolutions: 62,
    maxHeaderSize: 0,
    maxBlockBodySize: 0,
    ocertCounters: HashMap.empty(),
  };
};

const makeNonces = () =>
  new Nonces({
    active: new Uint8Array(32),
    evolving: new Uint8Array(32),
    candidate: new Uint8Array(32),
    epoch: 0n,
  });

describe("ChainSync driver", () => {
  it("initialVolatileState creates correct initial state", () => {
    const state = initialVolatileState(undefined, makeNonces());
    expect(state.tip).toBeUndefined();
    expect(state.blocksProcessed).toBe(0);
    expect(state.caughtUp).toBe(false);
  });

  layer(testLayers)((it) => {
    it.effect("handleRollForward updates tip and nonces", () =>
      Effect.gen(function* () {
        const nonces = makeNonces();
        const state = initialVolatileState(undefined, nonces);
        const headerBytes = makeBabbageHeader(42n, 20n, TEST_ISSUER_VK, TEST_VRF_VK);

        const newState = yield* handleRollForward(
          headerBytes,
          BABBAGE_ERA_VARIANT,
          { slot: 42n, blockNo: 20n, hash: new Uint8Array(32).fill(0x42) },
          state,
          "peer1",
          makeLedgerView(),
        );

        expect(newState.tip?.slot).toBe(42n);
        expect(newState.blocksProcessed).toBe(1);
        expect(newState.caughtUp).toBe(false);
      }),
    );

    it.effect("handleRollForward updates peer tip in PeerManager", () =>
      Effect.gen(function* () {
        const nonces = makeNonces();
        const state = initialVolatileState(undefined, nonces);
        const headerBytes = makeBabbageHeader(100n, 50n, TEST_ISSUER_VK, TEST_VRF_VK);
        const pm = yield* PeerManager;
        yield* pm.addPeer("peer1", "tcp://relay:3001");
        yield* handleRollForward(
          headerBytes,
          BABBAGE_ERA_VARIANT,
          { slot: 100n, blockNo: 50n, hash: new Uint8Array(32) },
          state,
          "peer1",
          makeLedgerView(),
        );
        const best = yield* pm.getBestPeer;
        expect(Option.isSome(best) && best.value.tip?.slot).toBe(100n);
      }),
    );

    it.effect(
      "handleRollBackward clears tip (envelope skipped for first post-rollback block)",
      () =>
        Effect.gen(function* () {
          const nonces = makeNonces();
          const state = initialVolatileState(
            { slot: 100n, blockNo: 50n, hash: new Uint8Array(32) },
            nonces,
          );

          const pm = yield* PeerManager;
          yield* pm.addPeer("peer1", "tcp://relay:3001");
          const newState = yield* handleRollBackward(
            { slot: 80n, hash: new Uint8Array(32).fill(0x80) },
            { slot: 90n, blockNo: 45n, hash: new Uint8Array(32) },
            state,
            "peer1",
          );

          expect(newState.tip).toBeUndefined();
        }),
    );

    it.effect("multiple RollForwards increment blocksProcessed", () =>
      Effect.gen(function* () {
        const nonces = makeNonces();
        let state = initialVolatileState(undefined, nonces);

        for (let i = 0; i < 5; i++) {
          // Chain prevHash: each block's prevHash = previous block's computed header hash
          const headerBytes = makeBabbageHeader(
            BigInt(i + 1),
            BigInt(i + 1),
            TEST_ISSUER_VK,
            TEST_VRF_VK,
            state.tip?.hash,
          );
          state = yield* handleRollForward(
            headerBytes,
            BABBAGE_ERA_VARIANT,
            { slot: BigInt(i + 1), blockNo: BigInt(i + 1), hash: new Uint8Array(32).fill(i) },
            state,
            "peer1",
            makeLedgerView(),
          );
        }

        expect(state.blocksProcessed).toBe(5);
        expect(state.tip?.slot).toBe(5n);
      }),
    );

    // Test-coverage gap #7 — every state-revert side effect of
    // `handleRollBackward` per `sync/driver.ts:436-487`. Each test
    // pins one piece of mutable state that the rollback handler must
    // restore.
    describe("handleRollBackward state revert", () => {
      it.effect("clears ocertCounters", () =>
        Effect.gen(function* () {
          const nonces = makeNonces();
          // Seed state with a non-empty ocertCounters map. Per
          // `validate/header.ts:386`, this would otherwise reject the
          // first post-rollback block with `CounterTooSmall` if the
          // new fork's seqNo is less than the recorded ceiling.
          const state = {
            ...initialVolatileState(
              { slot: 100n, blockNo: 50n, hash: new Uint8Array(32) },
              nonces,
            ),
            ocertCounters: HashMap.make(["pool-A", 5], ["pool-B", 7]),
          };

          const pm = yield* PeerManager;
          yield* pm.addPeer("peer1", "tcp://relay:3001");
          const newState = yield* handleRollBackward(
            { slot: 80n, hash: new Uint8Array(32).fill(0x80) },
            { slot: 90n, blockNo: 45n, hash: new Uint8Array(32) },
            state,
            "peer1",
          );

          expect(HashMap.size(newState.ocertCounters)).toBe(0);
        }),
      );

      it.effect("Origin rollback resets nonces to all-zeros (genesis)", () =>
        Effect.gen(function* () {
          // Seed state with non-zero nonces, then rollback to Origin.
          // Per driver.ts:470-475, Origin rollback ignores the
          // LedgerSnapshotStore and uses fresh zeros.
          const seededNonces = new Nonces({
            active: new Uint8Array(32).fill(0xab),
            evolving: new Uint8Array(32).fill(0xcd),
            candidate: new Uint8Array(32).fill(0xef),
            epoch: 100n,
          });
          const state = initialVolatileState(
            { slot: 100n, blockNo: 50n, hash: new Uint8Array(32) },
            seededNonces,
          );

          const pm = yield* PeerManager;
          yield* pm.addPeer("peer1", "tcp://relay:3001");
          const newState = yield* handleRollBackward(
            undefined, // Origin
            { slot: 90n, blockNo: 45n, hash: new Uint8Array(32) },
            state,
            "peer1",
          );

          expect(newState.nonces.epoch).toBe(0n);
          // Every byte of every nonce field is zero.
          expect(newState.nonces.active.every((b) => b === 0)).toBe(true);
          expect(newState.nonces.evolving.every((b) => b === 0)).toBe(true);
          expect(newState.nonces.candidate.every((b) => b === 0)).toBe(true);
        }),
      );

      it.effect("RealPoint rollback with empty snapshot store keeps state.nonces", () =>
        Effect.gen(function* () {
          // The default `stubLedgerSnapshots.readNonces = Option.none()`.
          // Per driver.ts:460-468, RealPoint + Option.none → keep current
          // state.nonces (don't overwrite).
          const seededNonces = new Nonces({
            active: new Uint8Array(32).fill(0x11),
            evolving: new Uint8Array(32).fill(0x22),
            candidate: new Uint8Array(32).fill(0x33),
            epoch: 5n,
          });
          const state = initialVolatileState(
            { slot: 100n, blockNo: 50n, hash: new Uint8Array(32) },
            seededNonces,
          );

          const pm = yield* PeerManager;
          yield* pm.addPeer("peer1", "tcp://relay:3001");
          const newState = yield* handleRollBackward(
            { slot: 80n, hash: new Uint8Array(32).fill(0x80) },
            { slot: 90n, blockNo: 45n, hash: new Uint8Array(32) },
            state,
            "peer1",
          );

          expect(newState.nonces.epoch).toBe(5n);
          expect(newState.nonces.active[0]).toBe(0x11);
          expect(newState.nonces.evolving[0]).toBe(0x22);
          expect(newState.nonces.candidate[0]).toBe(0x33);
        }),
      );

      it.effect("clears caughtUp flag (forces re-evaluation post-rollback)", () =>
        Effect.gen(function* () {
          // GSM transition: a CaughtUp node must drop back to Syncing
          // after a rollback because the chain has shifted under it.
          const state = {
            ...initialVolatileState(
              { slot: 100n, blockNo: 50n, hash: new Uint8Array(32) },
              makeNonces(),
            ),
            caughtUp: true,
          };

          const pm = yield* PeerManager;
          yield* pm.addPeer("peer1", "tcp://relay:3001");
          const newState = yield* handleRollBackward(
            { slot: 80n, hash: new Uint8Array(32).fill(0x80) },
            { slot: 90n, blockNo: 45n, hash: new Uint8Array(32) },
            state,
            "peer1",
          );

          expect(newState.caughtUp).toBe(false);
        }),
      );

      it.effect("preserves blocksProcessed (stat counter, not state)", () =>
        Effect.gen(function* () {
          // `blocksProcessed` is a monotonic stat — does not revert
          // on rollback. (driver.ts:481 only resets tip + nonces +
          // ocertCounters + caughtUp; blocksProcessed flows through.)
          const state = {
            ...initialVolatileState(
              { slot: 100n, blockNo: 50n, hash: new Uint8Array(32) },
              makeNonces(),
            ),
            blocksProcessed: 42,
          };

          const pm = yield* PeerManager;
          yield* pm.addPeer("peer1", "tcp://relay:3001");
          const newState = yield* handleRollBackward(
            { slot: 80n, hash: new Uint8Array(32).fill(0x80) },
            { slot: 90n, blockNo: 45n, hash: new Uint8Array(32) },
            state,
            "peer1",
          );

          expect(newState.blocksProcessed).toBe(42);
        }),
      );

      it.effect("updates peer tip in PeerManager regardless of rollback target", () =>
        Effect.gen(function* () {
          // PeerManager must learn the server's *current* tip even
          // though we just rolled back. Otherwise `getBestPeer` would
          // think we're caught up to a stale point.
          const state = initialVolatileState(
            { slot: 100n, blockNo: 50n, hash: new Uint8Array(32) },
            makeNonces(),
          );

          const pm = yield* PeerManager;
          yield* pm.addPeer("peer1", "tcp://relay:3001");
          const updatedTipHash = new Uint8Array(32).fill(0xee);
          yield* handleRollBackward(
            undefined, // Origin
            { slot: 90n, blockNo: 45n, hash: updatedTipHash },
            state,
            "peer1",
          );

          const peers = yield* pm.getPeers;
          const peer1 = peers.find((p) => p.peerId === "peer1");
          expect(peer1?.tip?.slot).toBe(90n);
          expect(peer1?.tip?.blockNo).toBe(45n);
        }),
      );
    });
  });
});
