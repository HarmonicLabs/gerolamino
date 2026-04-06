import { describe, it, expect } from "vitest";
import { Clock, Effect, Layer, Stream } from "effect";
import { getNodeStatus } from "../node";
import { PeerManager, PeerManagerLive } from "../peer-manager";
import { SlotClock, SlotClockLive, SlotConfig } from "../clock";
import { ChainDB } from "storage/services/chain-db";
import { ChainTip } from "../chain-selection";

const testConfig = new SlotConfig({
  systemStartMs: 0,
  slotLengthMs: 1000,
  epochLength: 100n,
  securityParam: 10,
  activeSlotsCoeff: 0.5,
});

const fixedClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => 500_000, // slot 500
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
  getTip: Effect.succeed({ slot: 450n, hash: new Uint8Array(32) }),
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
  slotClockLayer,
  peerManagerLayer,
  stubChainDb,
);

const run = <A>(effect: Effect.Effect<A, unknown, any>) =>
  Effect.runPromise(Effect.provide(effect, testLayers));

describe("Node orchestrator", () => {
  it("getNodeStatus reports tip and sync progress", async () => {
    const status = await run(getNodeStatus);
    expect(status.tipSlot).toBe(450n);
    expect(status.currentSlot).toBe(500n);
    expect(status.epochNumber).toBe(5n);
    expect(status.syncPercent).toBe(90);
    expect(status.gsmState).toBe("CaughtUp"); // 500-450=50 < stabilityWindow=60
  });

  it("getNodeStatus counts active peers", async () => {
    const status = await run(
      Effect.gen(function* () {
        const pm = yield* PeerManager;
        yield* pm.addPeer("p1", "tcp://p1:3001");
        yield* pm.addPeer("p2", "tcp://p2:3001");
        yield* pm.updatePeerTip("p1", new ChainTip({ slot: 500n, blockNo: 250n, hash: new Uint8Array(32) }));
        return yield* getNodeStatus;
      }),
    );
    expect(status.peerCount).toBe(2);
  });

  it("detects CaughtUp when tip is within stability window", async () => {
    const status = await run(getNodeStatus);
    // tip=450, current=500, diff=50, stabilityWindow=60 → CaughtUp
    expect(status.gsmState).toBe("CaughtUp");
  });
});
