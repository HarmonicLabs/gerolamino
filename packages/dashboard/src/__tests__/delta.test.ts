import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { AtomRegistry } from "effect/unstable/reactivity";
import { buildDeltaJson, applyDelta, replacer, reviver } from "../delta.ts";
import {
  INITIAL_NODE_STATE,
  INITIAL_BOOTSTRAP,
  nodeStateAtom,
  bootstrapAtom,
  peersAtom,
  syncSparklineAtom,
  chainEventLogAtom,
  type PeerInfo,
  type ChainEventEntry,
} from "../atoms/node-state.ts";

describe("delta replacer/reviver", () => {
  it("round-trips bigint", () => {
    const raw = JSON.stringify({ slot: 99_999_999_999n }, replacer);
    const parsed: unknown = JSON.parse(raw, reviver);
    expect(parsed).toEqual({ slot: 99_999_999_999n });
  });

  it("round-trips Uint8Array as hex", () => {
    const bytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    const raw = JSON.stringify({ hash: bytes }, replacer);
    const parsed: unknown = JSON.parse(raw, reviver);
    expect(parsed).toEqual({ hash: bytes });
  });

  it("leaves plain objects unchanged", () => {
    const raw = JSON.stringify({ ok: true, n: 1 }, replacer);
    const parsed: unknown = JSON.parse(raw, reviver);
    expect(parsed).toEqual({ ok: true, n: 1 });
  });
});

describe("buildDeltaJson / applyDelta", () => {
  it.effect("mirrors nodeState bigint fields across registries", () =>
    Effect.gen(function* () {
      const source = AtomRegistry.make();
      const target = AtomRegistry.make();
      const next = {
        ...INITIAL_NODE_STATE,
        status: "syncing" as const,
        tipSlot: 12_345_678n,
        syncPercent: 42.5,
      };
      source.set(nodeStateAtom, next);

      const json = buildDeltaJson(source);
      yield* applyDelta(target, json);

      expect(target.get(nodeStateAtom)).toEqual(next);
    }),
  );

  it.effect("mirrors peers and bootstrap partial snapshots", () =>
    Effect.gen(function* () {
      const source = AtomRegistry.make();
      const target = AtomRegistry.make();
      const peer: PeerInfo = {
        id: "peer-1",
        address: "127.0.0.1:3001",
        status: "synced",
        tipSlot: 100n,
        latencyMs: 12,
      };
      source.set(peersAtom, [peer]);
      source.set(bootstrapAtom, { ...INITIAL_BOOTSTRAP, phase: "receiving-blocks", blocksReceived: 10 });

      yield* applyDelta(target, buildDeltaJson(source));

      expect(target.get(peersAtom)).toEqual([peer]);
      expect(target.get(bootstrapAtom).blocksReceived).toBe(10);
    }),
  );

  it.effect("fails applyDelta when nodeState shape is invalid", () =>
    Effect.gen(function* () {
      const target = AtomRegistry.make();
      const exit = yield* Effect.exit(
        applyDelta(target, JSON.stringify({ nodeState: { status: "not-a-status" } })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("mirrors syncSparkline and chainEventLog with Uint8Array payloads", () =>
    Effect.gen(function* () {
      const source = AtomRegistry.make();
      const target = AtomRegistry.make();
      const event: ChainEventEntry = {
        _tag: "TipAdvanced",
        slot: 42n,
        blockNo: 41n,
        hash: Uint8Array.from([0xca, 0xfe]),
      };
      source.set(chainEventLogAtom, [event]);
      source.set(syncSparklineAtom, [1, 2, 3]);

      yield* applyDelta(target, buildDeltaJson(source));

      expect(target.get(syncSparklineAtom)).toEqual([1, 2, 3]);
      expect(target.get(chainEventLogAtom)).toEqual([event]);
    }),
  );
});
