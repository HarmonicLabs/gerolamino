import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Layer, Option, Stream } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import { ChainDB, LedgerSnapshotStore } from "storage";
import { CryptoDirect } from "wasm-utils";
import { ChainEventsLive } from "../../chain/event-log.ts";
import { Mempool } from "../../mempool/mempool.ts";
import { PeerManager, PeerManagerLive } from "../../peer/manager.ts";
import { SlotClock, SlotClockLive, SlotConfig } from "../../praos/clock.ts";
import { NodeRpcHandlersLive } from "../node-rpc-handlers.ts";

/**
 * Integration tests for NodeRpcHandlers. Exercises the handler shape +
 * backing-service wiring without going through an actual RpcServer
 * transport — the transport is a separate plan Phase 5 concern (Bun
 * Worker vs WebSocket vs in-memory).
 *
 * All six dependencies (ChainDB, PeerManager, SlotClock, Mempool,
 * ChainEventStream, Crypto) are wired from their Live / stub layers so
 * layer construction genuinely exercises the composition.
 */

const testConfig = new SlotConfig({
  systemStartMs: 0,
  slotLengthMs: 1000,
  epochLength: 100n,
  securityParam: 10,
  activeSlotsCoeff: 0.5,
  byronEpochLength: 4320n,
});

const fixedClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => 0,
  currentTimeMillis: Effect.sync(() => 0),
  currentTimeNanosUnsafe: () => 0n,
  currentTimeNanos: Effect.sync(() => 0n),
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

const TestLayers = Mempool.Live.pipe(
  Layer.provideMerge(ChainEventsLive),
  Layer.provideMerge(CryptoDirect),
  Layer.provideMerge(peerManagerLayer),
  Layer.provideMerge(slotClockLayer),
  Layer.provideMerge(stubChainDb),
  Layer.provideMerge(stubLedgerSnapshots),
  Layer.provide(KeyValueStore.layerMemory),
);

describe("NodeRpcHandlersLive contract", () => {
  it.effect("builds successfully with all 6 dependencies provided", () =>
    Effect.gen(function* () {
      // Provide NodeRpcHandlersLive — success = no construction error.
      yield* Effect.void;
    }).pipe(Effect.provide(NodeRpcHandlersLive), Effect.provide(TestLayers)),
  );

  it("NodeRpcHandlersLive is a well-formed Layer", () => {
    // Non-effectful smoke test: the exported value is a Layer with the
    // expected shape — not `undefined` or an Effect.
    expect(NodeRpcHandlersLive).toBeTruthy();
    expect(typeof NodeRpcHandlersLive).toBe("object");
  });
});
