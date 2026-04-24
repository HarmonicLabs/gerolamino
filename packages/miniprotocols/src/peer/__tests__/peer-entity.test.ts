/**
 * `Peer` Cluster-entity scaffolding tests — exercises the
 * declaration-level surface (`PeerId`, `Peer = Entity.make(...)`,
 * `PeerRegistry` / `PeerRegistryLive`, cursor-freshness helpers) without
 * a running Sharding fabric.
 *
 * Full handler round-trips via `Entity.makeTestClient` require a
 * matching Cluster runtime (the stub in Effect v4 beta.50 injects a
 * reserved `KeepAliveRpc` with a `Schema.Void` exit schema that
 * collides with user-return values in round-trip decoding). Until the
 * runtime is wired in Phase 3f (BlockSync + Cluster/Workflow
 * integration), direct layer tests give us the invariants we need:
 *
 *   1. `PeerId` carries a stable `PrimaryKey`.
 *   2. `PeerRegistryLive` publishes registrations into a
 *      `SubscriptionRef` that observers see via `Stream.takeUntil`.
 *   3. `selectPoints` + cursor-freshness helpers walk the agreed
 *      reset semantics on `MsgIntersectNotFound`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, HashMap, Option, PrimaryKey, Schema, Stream, SubscriptionRef } from "effect";

import { ChainPointType } from "../../protocols/types/ChainPoint";
import {
  buildIntersectionPoints,
  effectiveCursor,
  FreshnessResult,
  onIntersectionReply,
  wasReset,
} from "../cursor-freshness";
import { PeerRegistry, PeerRegistryLive } from "../handler";
import { PeerId } from "../Peer";

describe("Peer scaffolding", () => {
  it("PeerId is a schema-derived tagged class", () => {
    const id = new PeerId({ value: "alice.preprod:3001" });
    expect(id._tag).toBe("PeerId");
    expect(id.value).toBe("alice.preprod:3001");
    expect(Schema.is(PeerId)(id)).toBe(true);
  });

  it("PeerId.PrimaryKey is stable for the same value", () => {
    const a = new PeerId({ value: "peer-xyz" });
    const b = new PeerId({ value: "peer-xyz" });
    expect(a[PrimaryKey.symbol]()).toBe(b[PrimaryKey.symbol]());
    expect(a[PrimaryKey.symbol]()).toBe("peer-xyz");
  });

  it.effect("PeerRegistry.register publishes into the SubscriptionRef", () =>
    Effect.gen(function* () {
      const registry = yield* PeerRegistry;
      const id = new PeerId({ value: "alice.preprod:3001" });
      yield* registry.register(id, {
        host: "alice.preprod",
        port: 3001,
        networkMagic: 1,
        connectedAtMs: Date.now(),
        cursorSlot: Option.none(),
      });
      const snap = yield* registry.snapshot;
      expect(snap.length).toBe(1);
      expect(snap[0]!.meta.host).toBe("alice.preprod");
      expect(snap[0]!.meta.networkMagic).toBe(1);
    }).pipe(Effect.provide(PeerRegistryLive)),
  );

  it.effect("PeerRegistry.deregister removes the entry", () =>
    Effect.gen(function* () {
      const registry = yield* PeerRegistry;
      const id = new PeerId({ value: "bob.preprod:3001" });
      yield* registry.register(id, {
        host: "bob.preprod",
        port: 3001,
        networkMagic: 1,
        connectedAtMs: 0,
        cursorSlot: Option.none(),
      });
      yield* registry.deregister(id);
      const snap = yield* registry.snapshot;
      expect(snap.length).toBe(0);
    }).pipe(Effect.provide(PeerRegistryLive)),
  );

  it.effect("PeerRegistry.changes streams observable deltas", () =>
    Effect.gen(function* () {
      const registry = yield* PeerRegistry;
      // Seed two registrations, then take the head of the `changes`
      // stream — `SubscriptionRef.changes` re-emits the current value on
      // subscription, so the head observation reflects the settled state.
      yield* registry.register(new PeerId({ value: "a" }), {
        host: "a",
        port: 1,
        networkMagic: 1,
        connectedAtMs: 0,
        cursorSlot: Option.none(),
      });
      yield* registry.register(new PeerId({ value: "b" }), {
        host: "b",
        port: 2,
        networkMagic: 1,
        connectedAtMs: 0,
        cursorSlot: Option.none(),
      });

      const head = yield* Stream.runHead(registry.changes);
      expect(Option.isSome(head)).toBe(true);
      if (Option.isSome(head)) {
        expect(HashMap.size(head.value)).toBe(2);
      }
    }).pipe(Effect.provide(PeerRegistryLive)),
  );
});

describe("cursor-freshness helpers", () => {
  const hash32 = new Uint8Array(32).fill(0xab);
  const cursorPoint = {
    _tag: ChainPointType.RealPoint as const,
    slot: 12345,
    hash: hash32,
  };

  it("buildIntersectionPoints puts the persisted cursor first + appends Origin", () => {
    const pts = buildIntersectionPoints(cursorPoint, 100n, 500n);
    expect(pts.length).toBeGreaterThanOrEqual(2);
    expect(pts[0]).toEqual(cursorPoint);
    // Last candidate is always Origin (genesis fallback)
    expect(pts[pts.length - 1]?._tag).toBe(ChainPointType.Origin);
  });

  it.effect("IntersectFound → Resumed with same cursor", () =>
    Effect.gen(function* () {
      const result = yield* onIntersectionReply(
        { _tag: "IntersectFound", point: cursorPoint },
        cursorPoint,
      );
      expect(result._tag).toBe("Resumed");
      expect(effectiveCursor(result)).toEqual(cursorPoint);
      expect(wasReset(result)).toBe(false);
    }),
  );

  it.effect("IntersectNotFound → Reset to Origin", () =>
    Effect.gen(function* () {
      const result = yield* onIntersectionReply(
        { _tag: "IntersectNotFound" },
        cursorPoint,
      );
      expect(result._tag).toBe("Reset");
      expect(wasReset(result)).toBe(true);
      expect(effectiveCursor(result)._tag).toBe(ChainPointType.Origin);
    }),
  );

  it("FreshnessResult.match discriminates the two branches", () => {
    const matched = FreshnessResult.match(
      { _tag: "Resumed", cursor: cursorPoint },
      {
        Resumed: ({ cursor }) =>
          ChainPointType.RealPoint === cursor._tag ? `resumed:${cursor.slot}` : "resumed:origin",
        Reset: () => "reset",
      },
    );
    expect(matched).toBe("resumed:12345");
  });
});
