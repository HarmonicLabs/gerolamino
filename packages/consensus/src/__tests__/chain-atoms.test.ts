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
});
