/**
 * Chain Atoms daemon test — verifies `ChainAtomsLive` subscribes to the
 * `ChainEventStream` and mirrors each event into the published atoms.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as AtomRegistryModule from "effect/unstable/reactivity/AtomRegistry";

const { AtomRegistry } = AtomRegistryModule;
import {
  ChainAtomsLive,
  ChainEventsLive,
  chainLengthAtom,
  chainTipAtom,
  epochAtom,
  epochNonceAtom,
  rollbackCountAtom,
  writeChainEvent,
} from "../chain";

const TestLayers = ChainAtomsLive.pipe(
  Layer.provideMerge(ChainEventsLive),
  Layer.provideMerge(AtomRegistryModule.layer),
);

describe("chain/atoms — ChainAtomsLive daemon", () => {
  it.live("BlockAccepted updates tip + length", () =>
    Effect.gen(function* () {
      const registry = yield* AtomRegistry;

      yield* writeChainEvent({
        _tag: "BlockAccepted",
        slot: 100n,
        blockNo: 42n,
        hash: new Uint8Array(32).fill(0xaa),
        parentHash: new Uint8Array(32).fill(0x99),
      });

      // Yield the event loop so the daemon consumes the stream.
      // Yield the scheduler enough times for the daemon fiber to run.
      yield* Effect.sleep("100 millis").pipe(Effect.orDie);

      const tip = registry.get(chainTipAtom);
      const length = registry.get(chainLengthAtom);
      expect(tip?.slot).toBe(100n);
      expect(tip?.blockNo).toBe(42n);
      expect(length).toBe(1);
    }).pipe(Effect.provide(TestLayers)),
  );

  it.live("EpochBoundary updates epoch + nonce", () =>
    Effect.gen(function* () {
      const registry = yield* AtomRegistry;

      yield* writeChainEvent({
        _tag: "EpochBoundary",
        fromEpoch: 1n,
        toEpoch: 2n,
        epochNonce: new Uint8Array(32).fill(0xdd),
      });

      // Yield the scheduler enough times for the daemon fiber to run.
      yield* Effect.sleep("100 millis").pipe(Effect.orDie);

      expect(registry.get(epochAtom)).toBe(2n);
      const nonce = registry.get(epochNonceAtom);
      expect(nonce?.every((b) => b === 0xdd)).toBe(true);
    }).pipe(Effect.provide(TestLayers)),
  );

  it.live("RolledBack increments rollbackCount", () =>
    Effect.gen(function* () {
      const registry = yield* AtomRegistry;

      yield* writeChainEvent({
        _tag: "BlockAccepted",
        slot: 50n,
        blockNo: 10n,
        hash: new Uint8Array(32).fill(0x11),
        parentHash: new Uint8Array(32).fill(0x00),
      });
      yield* writeChainEvent({
        _tag: "RolledBack",
        to: { _tag: "RealPoint", slot: 40n, hash: new Uint8Array(32).fill(0x22) },
        depth: 3,
      });

      // Yield the scheduler enough times for the daemon fiber to run.
      yield* Effect.sleep("100 millis").pipe(Effect.orDie);

      expect(registry.get(rollbackCountAtom)).toBe(1);
      expect(registry.get(chainTipAtom)?.slot).toBe(40n);
    }).pipe(Effect.provide(TestLayers)),
  );

  // Test-coverage gap #15 — RolledBack to Origin (genesis) clears tip
  // and resets length to 0. Per `chain/atoms.ts:132-135`, the Origin
  // branch of `RollbackTarget.match` sets `chainTipAtom` back to
  // `undefined` and zeroes the length counter — distinct from the
  // RealPoint branch which keeps tip + clamps length.
  it.live("RolledBack to Origin clears chainTipAtom and resets chainLengthAtom to 0", () =>
    Effect.gen(function* () {
      const registry = yield* AtomRegistry;

      // Seed with 3 accepted blocks so length > 0 + tip defined.
      for (const [slot, blockNo] of [
        [10n, 1n],
        [20n, 2n],
        [30n, 3n],
      ] as const) {
        yield* writeChainEvent({
          _tag: "BlockAccepted",
          slot,
          blockNo,
          hash: new Uint8Array(32).fill(Number(blockNo)),
          parentHash: new Uint8Array(32).fill(Number(blockNo) - 1),
        });
      }
      yield* Effect.sleep("100 millis").pipe(Effect.orDie);
      // Sanity precondition — atoms reflect the 3 accepted blocks.
      expect(registry.get(chainLengthAtom)).toBe(3);
      expect(registry.get(chainTipAtom)?.slot).toBe(30n);

      yield* writeChainEvent({
        _tag: "RolledBack",
        to: { _tag: "Origin" },
        depth: 3,
      });
      yield* Effect.sleep("100 millis").pipe(Effect.orDie);

      // Origin branch: tip → undefined; length → 0; rollback counter ticks.
      expect(registry.get(chainTipAtom)).toBeUndefined();
      expect(registry.get(chainLengthAtom)).toBe(0);
      expect(registry.get(rollbackCountAtom)).toBe(1);
    }).pipe(Effect.provide(TestLayers)),
  );

  // Test-coverage gap #15 — length-clamping at 0 on a RealPoint
  // rollback. Per `chain/atoms.ts:121` the new length is
  // `clamp(n - depth, 0, MAX_SAFE_INTEGER)` — when `depth > n` the
  // subtraction would yield a negative integer, which the clamp pins
  // at 0. This guards against a future regression where the clamp is
  // removed and the atom holds a negative counter.
  it.live("RolledBack to RealPoint with depth > length clamps chainLengthAtom at 0", () =>
    Effect.gen(function* () {
      const registry = yield* AtomRegistry;

      // Seed with 2 blocks so length=2.
      yield* writeChainEvent({
        _tag: "BlockAccepted",
        slot: 10n,
        blockNo: 1n,
        hash: new Uint8Array(32).fill(0x11),
        parentHash: new Uint8Array(32).fill(0x00),
      });
      yield* writeChainEvent({
        _tag: "BlockAccepted",
        slot: 20n,
        blockNo: 2n,
        hash: new Uint8Array(32).fill(0x22),
        parentHash: new Uint8Array(32).fill(0x11),
      });
      yield* Effect.sleep("100 millis").pipe(Effect.orDie);
      expect(registry.get(chainLengthAtom)).toBe(2);

      // Rollback depth (10) exceeds current length (2). The clamp at
      // `chain/atoms.ts:121` keeps the counter at 0 instead of letting
      // it dip to -8.
      yield* writeChainEvent({
        _tag: "RolledBack",
        to: { _tag: "RealPoint", slot: 5n, hash: new Uint8Array(32).fill(0xab) },
        depth: 10,
      });
      yield* Effect.sleep("100 millis").pipe(Effect.orDie);

      expect(registry.get(chainLengthAtom)).toBe(0);
      // Tip slot drops to the RealPoint target — the assertion mirrors
      // the existing rollback test but with the clamped length above
      // it as the new fact this test pins.
      expect(registry.get(chainTipAtom)?.slot).toBe(5n);
    }).pipe(Effect.provide(TestLayers)),
  );
});
