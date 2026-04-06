import { describe, it, expect } from "vitest";
import { Clock, Effect, Layer } from "effect";
import { PeerManager, PeerManagerLive } from "../peer-manager";
import { SlotClock, SlotClockLive, SlotConfig } from "../clock";
import { ChainTip } from "../chain-selection";

const testConfig = new SlotConfig({
  systemStartMs: 0,
  slotLengthMs: 1000,
  epochLength: 100n,
  securityParam: 10,
  activeSlotsCoeff: 0.5,
});

const fixedClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => 200_000,
  currentTimeMillis: Effect.sync(() => 200_000),
  currentTimeNanosUnsafe: () => 200_000_000_000n,
  currentTimeNanos: Effect.sync(() => 200_000_000_000n),
  sleep: () => Effect.void,
};

const slotClockLayer = Layer.effect(
  SlotClock,
  SlotClockLive(testConfig).pipe(Effect.provideService(Clock.Clock, fixedClock)),
);

const peerManagerLayer = Layer.effect(PeerManager, PeerManagerLive).pipe(
  Layer.provide(slotClockLayer),
);

const run = <A>(effect: Effect.Effect<A, unknown, PeerManager>) =>
  Effect.runPromise(Effect.provide(effect, peerManagerLayer));

const makeTip = (slot: bigint, blockNo: bigint): ChainTip =>
  new ChainTip({ slot, blockNo, hash: new Uint8Array(32) });

describe("PeerManager", () => {
  it("adds and retrieves peers", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pm = yield* PeerManager;
        yield* pm.addPeer("peer1", "tcp://relay1:3001");
        yield* pm.addPeer("peer2", "tcp://relay2:3001");
        return yield* pm.getPeers;
      }),
    );
    expect(result.length).toBe(2);
    expect(result[0]?.status).toBe("connecting");
  });

  it("updates peer tip and status", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pm = yield* PeerManager;
        yield* pm.addPeer("peer1", "tcp://relay1:3001");
        yield* pm.updatePeerTip("peer1", makeTip(100n, 50n));
        return yield* pm.getPeers;
      }),
    );
    expect(result[0]?.status).toBe("syncing");
    expect(result[0]?.tip?.slot).toBe(100n);
    expect(result[0]?.headersReceived).toBe(1);
  });

  it("selects best peer by Praos rules", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pm = yield* PeerManager;
        yield* pm.addPeer("slow", "tcp://slow:3001");
        yield* pm.updatePeerTip("slow", makeTip(100n, 50n));
        yield* pm.addPeer("fast", "tcp://fast:3001");
        yield* pm.updatePeerTip("fast", makeTip(200n, 100n));
        return yield* pm.getBestPeer;
      }),
    );
    expect(result?.peerId).toBe("fast");
  });

  it("ignores disconnected peers for best selection", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pm = yield* PeerManager;
        yield* pm.addPeer("good", "tcp://good:3001");
        yield* pm.updatePeerTip("good", makeTip(100n, 50n));
        yield* pm.addPeer("bad", "tcp://bad:3001");
        yield* pm.updatePeerTip("bad", makeTip(200n, 100n));
        yield* pm.removePeer("bad");
        return yield* pm.getBestPeer;
      }),
    );
    expect(result?.peerId).toBe("good");
  });

  it("counts peers by status", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pm = yield* PeerManager;
        yield* pm.addPeer("a", "tcp://a:3001");
        yield* pm.addPeer("b", "tcp://b:3001");
        yield* pm.updatePeerTip("b", makeTip(100n, 50n));
        yield* pm.addPeer("c", "tcp://c:3001");
        yield* pm.removePeer("c");
        return yield* pm.getStatusCounts;
      }),
    );
    expect(result.connecting).toBe(1); // a
    expect(result.syncing).toBe(1); // b
    expect(result.disconnected).toBe(1); // c
  });

  it("returns undefined when no peers have tips", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pm = yield* PeerManager;
        yield* pm.addPeer("new", "tcp://new:3001");
        return yield* pm.getBestPeer;
      }),
    );
    expect(result).toBeUndefined();
  });
});
