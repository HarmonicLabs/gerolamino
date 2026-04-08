import { describe, expect } from "vitest";
import { it, layer } from "@effect/vitest";
import { Clock, Effect, Layer, Stream } from "effect";
import {
  handleRollForward,
  handleRollBackward,
  initialVolatileState,
} from "../chain-sync-driver";
import { ConsensusEngineWithBunCrypto } from "../consensus-engine";
import { PeerManager, PeerManagerLive } from "../peer-manager";
import { SlotClock, SlotClockLive, SlotConfig } from "../clock";
import { ChainDB } from "storage/services/chain-db";
import { Nonces } from "../nonce";
import { hex } from "../util";
import type { LedgerView } from "../validate-header";

const testConfig = new SlotConfig({
  systemStartMs: 0,
  slotLengthMs: 1000,
  epochLength: 100n,
  securityParam: 10,
  activeSlotsCoeff: 0.5,
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
  getBlock: () => Effect.succeed(undefined),
  getBlockAt: () => Effect.succeed(undefined),
  getTip: Effect.succeed(undefined),
  getImmutableTip: Effect.succeed(undefined),
  addBlock: () => Effect.void,
  rollback: () => Effect.void,
  getSuccessors: () => Effect.succeed([]),
  streamFrom: () => Stream.empty,
  promoteToImmutable: () => Effect.void,
  garbageCollect: () => Effect.void,
  writeLedgerSnapshot: () => Effect.void,
  readLatestLedgerSnapshot: Effect.succeed(undefined),
});

const testLayers = Layer.mergeAll(
  ConsensusEngineWithBunCrypto,
  slotClockLayer,
  peerManagerLayer,
  stubChainDb,
);

const poolIdFromVk = (vk: Uint8Array): string => {
  const hasher = new Bun.CryptoHasher("blake2b256");
  return hex(new Uint8Array(hasher.update(vk).digest().buffer));
};

const makeLedgerView = (): LedgerView => {
  const vk = new Uint8Array(32);
  vk[0] = 1;
  const poolId = poolIdFromVk(vk);
  const vrfVk = new Uint8Array(32);
  vrfVk[0] = 2;
  return {
    epochNonce: new Uint8Array(32),
    poolVrfKeys: new Map([[poolId, vrfVk]]),
    poolStake: new Map([[poolId, 1_000_000n]]),
    totalStake: 10_000_000n,
    activeSlotsCoeff: 0.05,
    maxKesEvolutions: 62,
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

        const newState = yield* handleRollForward(
          new Uint8Array(100),
          { slot: 42n, blockNo: 20n, hash: new Uint8Array(32).fill(0x42) },
          state,
          "peer1",
          makeLedgerView(),
        );

        expect(newState.tip?.slot).toBe(42n);
        expect(newState.blocksProcessed).toBe(1);
        expect(newState.caughtUp).toBe(false);
        expect(newState.nonces.evolving).toEqual(nonces.evolving);
      }),
    );

    it.effect("handleRollForward updates peer tip in PeerManager", () =>
      Effect.gen(function* () {
        const nonces = makeNonces();
        const state = initialVolatileState(undefined, nonces);
        const pm = yield* PeerManager;
        yield* pm.addPeer("peer1", "tcp://relay:3001");
        yield* handleRollForward(
          new Uint8Array(100),
          { slot: 100n, blockNo: 50n, hash: new Uint8Array(32) },
          state,
          "peer1",
          makeLedgerView(),
        );
        const best = yield* pm.getBestPeer;
        expect(best?.tip?.slot).toBe(100n);
      }),
    );

    it.effect("handleRollBackward reverts tip to rollback point", () =>
      Effect.gen(function* () {
        const nonces = makeNonces();
        const state = initialVolatileState(
          { slot: 100n, hash: new Uint8Array(32) },
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

        expect(newState.tip?.slot).toBe(80n);
      }),
    );

    it.effect("multiple RollForwards increment blocksProcessed", () =>
      Effect.gen(function* () {
        const nonces = makeNonces();
        let state = initialVolatileState(undefined, nonces);

        for (let i = 0; i < 5; i++) {
          state = yield* handleRollForward(
            new Uint8Array(100),
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
  });
});
