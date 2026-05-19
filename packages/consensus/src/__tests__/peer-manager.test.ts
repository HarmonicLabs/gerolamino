import { describe, it, expect } from "@effect/vitest";
import { Clock, Effect, Layer, Option, Ref } from "effect";
import { PeerManager, PeerManagerLive } from "../peer/manager";
import { SlotClock, SlotClockLive, SlotConfig } from "../praos/clock";
import { ChainTip } from "../chain/selection";

const testConfig = new SlotConfig({
  systemStartMs: 0,
  slotLengthMs: 1000,
  epochLength: 100n,
  securityParam: 10,
  activeSlotsCoeff: 0.5,
  byronEpochLength: 4320n,
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

const provide = <A>(effect: Effect.Effect<A, unknown, PeerManager>) =>
  effect.pipe(Effect.provide(peerManagerLayer));

const makeTip = (slot: bigint, blockNo: bigint): ChainTip =>
  new ChainTip({ slot, blockNo, hash: new Uint8Array(32) });

describe("PeerManager", () => {
  it.effect("adds and retrieves peers", () =>
    provide(
      Effect.gen(function* () {
        const pm = yield* PeerManager;
        yield* pm.addPeer("peer1", "tcp://relay1:3001");
        yield* pm.addPeer("peer2", "tcp://relay2:3001");
        const result = yield* pm.getPeers;
        expect(result.length).toBe(2);
        expect(result[0]?.status).toBe("connecting");
      }),
    ),
  );

  it.effect("updates peer tip and status", () =>
    provide(
      Effect.gen(function* () {
        const pm = yield* PeerManager;
        yield* pm.addPeer("peer1", "tcp://relay1:3001");
        yield* pm.updatePeerTip("peer1", makeTip(100n, 50n));
        const result = yield* pm.getPeers;
        expect(result[0]?.status).toBe("syncing");
        expect(result[0]?.tip?.slot).toBe(100n);
        expect(result[0]?.headersReceived).toBe(1);
      }),
    ),
  );

  it.effect("selects best peer by Praos rules", () =>
    provide(
      Effect.gen(function* () {
        const pm = yield* PeerManager;
        yield* pm.addPeer("slow", "tcp://slow:3001");
        yield* pm.updatePeerTip("slow", makeTip(100n, 50n));
        yield* pm.addPeer("fast", "tcp://fast:3001");
        yield* pm.updatePeerTip("fast", makeTip(200n, 100n));
        const result = yield* pm.getBestPeer;
        expect(Option.isSome(result) && result.value.peerId).toBe("fast");
      }),
    ),
  );

  it.effect("ignores disconnected peers for best selection", () =>
    provide(
      Effect.gen(function* () {
        const pm = yield* PeerManager;
        yield* pm.addPeer("good", "tcp://good:3001");
        yield* pm.updatePeerTip("good", makeTip(100n, 50n));
        yield* pm.addPeer("bad", "tcp://bad:3001");
        yield* pm.updatePeerTip("bad", makeTip(200n, 100n));
        yield* pm.removePeer("bad");
        const result = yield* pm.getBestPeer;
        expect(Option.isSome(result) && result.value.peerId).toBe("good");
      }),
    ),
  );

  it.effect("counts peers by status", () =>
    provide(
      Effect.gen(function* () {
        const pm = yield* PeerManager;
        yield* pm.addPeer("a", "tcp://a:3001");
        yield* pm.addPeer("b", "tcp://b:3001");
        yield* pm.updatePeerTip("b", makeTip(100n, 50n));
        yield* pm.addPeer("c", "tcp://c:3001");
        yield* pm.removePeer("c");
        const result = yield* pm.getStatusCounts;
        expect(result.connecting).toBe(1); // a
        expect(result.syncing).toBe(1); // b
        expect(result.disconnected).toBe(1); // c
      }),
    ),
  );

  it.effect("returns none when no peers have tips", () =>
    provide(
      Effect.gen(function* () {
        const pm = yield* PeerManager;
        yield* pm.addPeer("new", "tcp://new:3001");
        const result = yield* pm.getBestPeer;
        expect(Option.isNone(result)).toBe(true);
      }),
    ),
  );

  // Total-order stability — `getBestPeer` reduces over the peer
  // HashMap with `preferCandidate` as the comparator. For the reduce
  // to be deterministic, the comparator must be a total order at
  // shallow fork depth (transitivity is pinned by
  // `chain-selection.property.test.ts`). These tests assert that the
  // winner is consistent across insertion permutations.
  describe("getBestPeer total-order stability", () => {
    it.effect("3 peers with strict blockNo ordering — best is the longest chain", () =>
      provide(
        Effect.gen(function* () {
          const pm = yield* PeerManager;
          yield* pm.addPeer("low", "tcp://low:3001");
          yield* pm.updatePeerTip("low", makeTip(100n, 50n));
          yield* pm.addPeer("mid", "tcp://mid:3001");
          yield* pm.updatePeerTip("mid", makeTip(150n, 75n));
          yield* pm.addPeer("high", "tcp://high:3001");
          yield* pm.updatePeerTip("high", makeTip(200n, 100n));
          const result = yield* pm.getBestPeer;
          expect(Option.isSome(result) && result.value.peerId).toBe("high");
        }),
      ),
    );

    it.effect("permutation invariance — insertion order doesn't change the winner", () =>
      provide(
        Effect.gen(function* () {
          // Insert in REVERSE order to confirm getBestPeer doesn't
          // accidentally lean on first-come-first-served.
          const pm = yield* PeerManager;
          yield* pm.addPeer("high", "tcp://high:3001");
          yield* pm.updatePeerTip("high", makeTip(200n, 100n));
          yield* pm.addPeer("mid", "tcp://mid:3001");
          yield* pm.updatePeerTip("mid", makeTip(150n, 75n));
          yield* pm.addPeer("low", "tcp://low:3001");
          yield* pm.updatePeerTip("low", makeTip(100n, 50n));
          const result = yield* pm.getBestPeer;
          // Same winner as the forward-order test above.
          expect(Option.isSome(result) && result.value.peerId).toBe("high");
        }),
      ),
    );

    it.effect("equal blockNo tie — VRF tiebreak picks lexicographically-smaller", () =>
      provide(
        Effect.gen(function* () {
          // Both peers report blockNo=100 but distinct VRF outputs.
          // Per `preferCandidate` rule 2, lower VRF wins.
          const pm = yield* PeerManager;
          const lowVrf = new Uint8Array(32).fill(0x10);
          const highVrf = new Uint8Array(32).fill(0xf0);
          yield* pm.addPeer("low-vrf", "tcp://lv:3001");
          yield* pm.updatePeerTip(
            "low-vrf",
            new ChainTip({
              slot: 200n,
              blockNo: 100n,
              hash: new Uint8Array(32),
              vrfOutput: lowVrf,
            }),
          );
          yield* pm.addPeer("high-vrf", "tcp://hv:3001");
          yield* pm.updatePeerTip(
            "high-vrf",
            new ChainTip({
              slot: 200n,
              blockNo: 100n,
              hash: new Uint8Array(32),
              vrfOutput: highVrf,
            }),
          );
          const result = yield* pm.getBestPeer;
          expect(Option.isSome(result) && result.value.peerId).toBe("low-vrf");
        }),
      ),
    );

    it.effect("equal blockNo, no VRF — tiebreak unavailable, first-tip-set wins", () =>
      provide(
        Effect.gen(function* () {
          // Per `preferCandidate` "tiebreak unavailable" branch
          // (`chain/selection.ts:62-63`), without VRF on either side
          // the comparator returns false, so reduce keeps the
          // accumulator (first peer with a tip seen).
          const pm = yield* PeerManager;
          yield* pm.addPeer("first", "tcp://1:3001");
          yield* pm.updatePeerTip("first", makeTip(100n, 50n));
          yield* pm.addPeer("second", "tcp://2:3001");
          yield* pm.updatePeerTip("second", makeTip(100n, 50n));
          const result = yield* pm.getBestPeer;
          // Both have equal tips and no VRF — the existing winner
          // (whichever the reduce first encounters) sticks.
          expect(Option.isSome(result)).toBe(true);
          // Just assert the result is one of the two — exact pick
          // depends on HashMap iteration order, which is not part of
          // the contract.
          if (Option.isSome(result)) {
            expect(["first", "second"]).toContain(result.value.peerId);
          }
        }),
      ),
    );

    it.effect("removed best peer — getBestPeer falls through to next", () =>
      provide(
        Effect.gen(function* () {
          const pm = yield* PeerManager;
          yield* pm.addPeer("p1", "tcp://1:3001");
          yield* pm.updatePeerTip("p1", makeTip(100n, 50n));
          yield* pm.addPeer("p2", "tcp://2:3001");
          yield* pm.updatePeerTip("p2", makeTip(200n, 100n));
          // p2 is the current winner.
          let result = yield* pm.getBestPeer;
          expect(Option.isSome(result) && result.value.peerId).toBe("p2");
          // Remove p2 → p1 takes over.
          yield* pm.removePeer("p2");
          result = yield* pm.getBestPeer;
          expect(Option.isSome(result) && result.value.peerId).toBe("p1");
        }),
      ),
    );
  });

  // Test-coverage gap #6 — detectStalls actually marks peers stalled
  // past the timeout. The default `PEER_STALL_TIMEOUT_MS` is 120_000
  // (2 min) per `peer/manager.ts:58-60`. The previous fixedClock-only
  // test pattern can't cover this because every call sees the same
  // wallclock — we need a mutable clock that advances between
  // `addPeer` (which sets `lastActivityMs = now`) and `detectStalls`
  // (which checks `now - lastActivityMs > stallTimeoutMs`).
  describe("detectStalls", () => {
    const STALL_TIMEOUT_MS = 120_000;

    /** Build a Clock layer where `currentTimeMillis` reads from a Ref
     *  the test can advance between operations. */
    const advancingClockLayers = Effect.gen(function* () {
      const nowRef = yield* Ref.make<number>(1_000_000); // arbitrary epoch
      const advancingClock: Clock.Clock = {
        currentTimeMillisUnsafe: () => Effect.runSync(Ref.get(nowRef)),
        currentTimeMillis: Ref.get(nowRef),
        currentTimeNanosUnsafe: () => BigInt(Effect.runSync(Ref.get(nowRef))) * 1_000_000n,
        currentTimeNanos: Effect.map(Ref.get(nowRef), (ms) => BigInt(ms) * 1_000_000n),
        sleep: () => Effect.void,
      };
      const advancingSlotClock = Layer.effect(
        SlotClock,
        SlotClockLive(testConfig).pipe(Effect.provideService(Clock.Clock, advancingClock)),
      );
      const pmLayer = Layer.effect(PeerManager, PeerManagerLive).pipe(
        Layer.provide(advancingSlotClock),
        Layer.provideMerge(Layer.succeedContext(Clock.Clock.context(advancingClock))),
      );
      return { nowRef, pmLayer };
    });

    it.effect("marks peer as stalled when lastActivityMs > stallTimeoutMs in the past", () =>
      Effect.gen(function* () {
        const { nowRef, pmLayer } = yield* advancingClockLayers;

        const stalledIds = yield* Effect.gen(function* () {
          const pm = yield* PeerManager;
          // Add peer at t=1_000_000 → lastActivityMs = 1_000_000.
          yield* pm.addPeer("p1", "tcp://1:3001");
          // Advance clock past the timeout window (+ 1 ms over).
          yield* Ref.set(nowRef, 1_000_000 + STALL_TIMEOUT_MS + 1);
          return yield* pm.detectStalls;
        }).pipe(Effect.provide(pmLayer));

        expect(stalledIds).toContain("p1");
      }),
    );

    it.effect("does NOT mark peer stalled when within timeout (boundary)", () =>
      Effect.gen(function* () {
        const { nowRef, pmLayer } = yield* advancingClockLayers;

        const result = yield* Effect.gen(function* () {
          const pm = yield* PeerManager;
          yield* pm.addPeer("p1", "tcp://1:3001");
          // Advance to EXACTLY the timeout (`>` is strict;
          // `manager.ts:242` uses strict greater-than).
          yield* Ref.set(nowRef, 1_000_000 + STALL_TIMEOUT_MS);
          return yield* pm.detectStalls;
        }).pipe(Effect.provide(pmLayer));

        expect(result).toEqual([]);
      }),
    );

    it.effect("does NOT mark already-disconnected peers stalled", () =>
      Effect.gen(function* () {
        const { nowRef, pmLayer } = yield* advancingClockLayers;

        const result = yield* Effect.gen(function* () {
          const pm = yield* PeerManager;
          yield* pm.addPeer("p1", "tcp://1:3001");
          yield* pm.removePeer("p1"); // flips p1 to "disconnected"
          yield* Ref.set(nowRef, 1_000_000 + STALL_TIMEOUT_MS + 1);
          // `isEligibleForStall` excludes disconnected + stalled
          // (manager.ts:73-74); detectStalls should skip p1.
          return yield* pm.detectStalls;
        }).pipe(Effect.provide(pmLayer));

        expect(result).toEqual([]);
      }),
    );

    it.effect("does NOT re-mark already-stalled peers", () =>
      Effect.gen(function* () {
        const { nowRef, pmLayer } = yield* advancingClockLayers;

        const secondCallResult = yield* Effect.gen(function* () {
          const pm = yield* PeerManager;
          yield* pm.addPeer("p1", "tcp://1:3001");
          yield* Ref.set(nowRef, 1_000_000 + STALL_TIMEOUT_MS + 1);
          // First call marks p1 stalled.
          yield* pm.detectStalls;
          // Second call should return [] — p1 is already stalled.
          return yield* pm.detectStalls;
        }).pipe(Effect.provide(pmLayer));

        expect(secondCallResult).toEqual([]);
      }),
    );

    it.effect("only flags eligible peers, not the active one", () =>
      Effect.gen(function* () {
        const { nowRef, pmLayer } = yield* advancingClockLayers;

        const stalledIds = yield* Effect.gen(function* () {
          const pm = yield* PeerManager;
          // Add p1 at t=1_000_000.
          yield* pm.addPeer("p1", "tcp://1:3001");
          // Advance to t=1_080_000 (60s in) and add p2 — its
          // lastActivityMs becomes 1_080_000.
          yield* Ref.set(nowRef, 1_080_000);
          yield* pm.addPeer("p2", "tcp://2:3001");
          // Advance to t=1_000_000 + 120_001 (just past p1's
          // timeout but well within p2's window — p2 still has
          // 60s of activity).
          yield* Ref.set(nowRef, 1_000_000 + STALL_TIMEOUT_MS + 1);
          return yield* pm.detectStalls;
        }).pipe(Effect.provide(pmLayer));

        // p1 is past timeout, p2 is not — only p1 marked.
        expect(stalledIds).toEqual(["p1"]);
      }),
    );
  });
});
