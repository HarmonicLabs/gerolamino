import { describe, it, expect } from "vitest";
import { Clock, Effect, Layer, Stream } from "effect";
import {
  handleRollForward,
  handleRollBackward,
  initialVolatileState,
} from "../chain-sync-driver";
import { ConsensusEngineWithBunCrypto } from "../consensus-engine";
import { PeerManager, PeerManagerLive } from "../peer-manager";
import { SlotClock, SlotClockLive, SlotConfig } from "../clock";
import { ImmutableDB } from "storage/services/index";
import { Nonces } from "../nonce";
import type { StoredBlock } from "storage/types/StoredBlock";
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

const stubImmutableDb = Layer.succeed(ImmutableDB, {
  appendBlock: (_block: StoredBlock) => Effect.void,
  readBlock: () => Effect.succeed(undefined),
  getTip: Effect.succeed(undefined),
  streamBlocks: () => Stream.empty,
});

const testLayers = Layer.mergeAll(
  ConsensusEngineWithBunCrypto,
  slotClockLayer,
  peerManagerLayer,
  stubImmutableDb,
);

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

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

const run = <A>(effect: Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(Effect.provide(effect, testLayers));

describe("ChainSync driver", () => {
  it("initialVolatileState creates correct initial state", () => {
    const state = initialVolatileState(undefined, new Nonces({
      active: new Uint8Array(32),
      evolving: new Uint8Array(32),
      candidate: new Uint8Array(32),
      epoch: 0n,
    }));
    expect(state.tip).toBeUndefined();
    expect(state.blocksProcessed).toBe(0);
    expect(state.caughtUp).toBe(false);
  });

  it("handleRollForward updates tip and nonces", async () => {
    const nonces = new Nonces({
      active: new Uint8Array(32),
      evolving: new Uint8Array(32),
      candidate: new Uint8Array(32),
      epoch: 0n,
    });
    const state = initialVolatileState(undefined, nonces);

    const newState = await run(
      handleRollForward(
        new Uint8Array(100), // header bytes (placeholder)
        { slot: 42n, blockNo: 20n, hash: new Uint8Array(32).fill(0x42) },
        state,
        "peer1",
        makeLedgerView(),
      ),
    );

    expect(newState.tip?.slot).toBe(42n);
    expect(newState.blocksProcessed).toBe(1);
    expect(newState.caughtUp).toBe(false);
    // Nonces should have evolved
    expect(newState.nonces.evolving).not.toEqual(nonces.evolving);
  });

  it("handleRollForward updates peer tip in PeerManager", async () => {
    const nonces = new Nonces({
      active: new Uint8Array(32),
      evolving: new Uint8Array(32),
      candidate: new Uint8Array(32),
      epoch: 0n,
    });
    const state = initialVolatileState(undefined, nonces);

    await run(
      Effect.gen(function* () {
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
        return best;
      }),
    ).then((best) => {
      expect(best?.tip?.slot).toBe(100n);
    });
  });

  it("handleRollBackward reverts tip to rollback point", async () => {
    const nonces = new Nonces({
      active: new Uint8Array(32),
      evolving: new Uint8Array(32),
      candidate: new Uint8Array(32),
      epoch: 0n,
    });
    const state = initialVolatileState(
      { slot: 100n, hash: new Uint8Array(32) },
      nonces,
    );

    const newState = await run(
      Effect.gen(function* () {
        const pm = yield* PeerManager;
        yield* pm.addPeer("peer1", "tcp://relay:3001");
        return yield* handleRollBackward(
          { slot: 80n, hash: new Uint8Array(32).fill(0x80) },
          { slot: 90n, blockNo: 45n, hash: new Uint8Array(32) },
          state,
          "peer1",
        );
      }),
    );

    expect(newState.tip?.slot).toBe(80n);
  });

  it("multiple RollForwards increment blocksProcessed", async () => {
    const nonces = new Nonces({
      active: new Uint8Array(32),
      evolving: new Uint8Array(32),
      candidate: new Uint8Array(32),
      epoch: 0n,
    });
    let state = initialVolatileState(undefined, nonces);

    for (let i = 0; i < 5; i++) {
      state = await run(
        handleRollForward(
          new Uint8Array(100),
          { slot: BigInt(i + 1), blockNo: BigInt(i + 1), hash: new Uint8Array(32).fill(i) },
          state,
          "peer1",
          makeLedgerView(),
        ),
      );
    }

    expect(state.blocksProcessed).toBe(5);
    expect(state.tip?.slot).toBe(5n);
  });
});
