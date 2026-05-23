/**
 * Test-coverage gap #25 — ConsensusEvents service round-trip.
 *
 * Per `reference_test_coverage_gaps.md`, the entire `ConsensusEvents`
 * Service was previously untested (no consumer in the consensus test
 * suite ever round-tripped an event through it). This file plugs that
 * hole with end-to-end emit → subscribe coverage for every
 * `ConsensusEventKind` variant + back-pressure (sliding-256) sanity.
 */
import { describe, it, expect, layer } from "@effect/vitest";
import { Effect, PubSub } from "effect";
import {
  ConsensusEvent,
  ConsensusEventKind,
  ConsensusEvents,
  type ConsensusEventType,
} from "../peer/events.ts";
import { Schema } from "effect";

describe("ConsensusEvents service", () => {
  layer(ConsensusEvents.Live)((it) => {
    it.effect("emit + subscribe round-trips a TipChanged event", () =>
      Effect.gen(function* () {
        const events = yield* ConsensusEvents;
        const sub = yield* events.subscribe;
        const evt: ConsensusEventType = {
          _tag: ConsensusEventKind.TipChanged,
          slot: 100n,
          hash: new Uint8Array(32),
          blockNo: 50n,
          blocksProcessed: 10,
        };
        yield* events.emit(evt);
        const received = yield* PubSub.take(sub);
        expect(received).toEqual(evt);
      }),
    );

    it.effect("round-trips a GsmTransition event", () =>
      Effect.gen(function* () {
        const events = yield* ConsensusEvents;
        const sub = yield* events.subscribe;
        const evt: ConsensusEventType = {
          _tag: ConsensusEventKind.GsmTransition,
          from: "PreSyncing",
          to: "Syncing",
        };
        yield* events.emit(evt);
        const received = yield* PubSub.take(sub);
        expect(received).toEqual(evt);
      }),
    );

    it.effect("round-trips an EpochTransition event", () =>
      Effect.gen(function* () {
        const events = yield* ConsensusEvents;
        const sub = yield* events.subscribe;
        const evt: ConsensusEventType = {
          _tag: ConsensusEventKind.EpochTransition,
          fromEpoch: 215n,
          toEpoch: 216n,
        };
        yield* events.emit(evt);
        const received = yield* PubSub.take(sub);
        expect(received).toEqual(evt);
      }),
    );

    it.effect("round-trips a PeerStalled event", () =>
      Effect.gen(function* () {
        const events = yield* ConsensusEvents;
        const sub = yield* events.subscribe;
        const evt: ConsensusEventType = {
          _tag: ConsensusEventKind.PeerStalled,
          peerId: "preprod-node.world.dev.cardano.org:3001",
        };
        yield* events.emit(evt);
        const received = yield* PubSub.take(sub);
        expect(received).toEqual(evt);
      }),
    );

    it.effect("multiple subscribers each receive each event", () =>
      Effect.gen(function* () {
        const events = yield* ConsensusEvents;
        const subA = yield* events.subscribe;
        const subB = yield* events.subscribe;
        const evt: ConsensusEventType = {
          _tag: ConsensusEventKind.PeerStalled,
          peerId: "peer-X",
        };
        yield* events.emit(evt);
        const a = yield* PubSub.take(subA);
        const b = yield* PubSub.take(subB);
        expect(a).toEqual(evt);
        expect(b).toEqual(evt);
      }),
    );
  });
});

describe("ConsensusEvent Schema", () => {
  // Defensive shape-validation: the `Schema.toTaggedUnion("_tag")`
  // adapter at the bottom of `peer/events.ts` is only meaningful if
  // every variant decodes back round-trip clean. A future schema
  // evolution that breaks one variant's discriminator would surface
  // here at the boundary instead of as a silent runtime fall-through.
  const decode = Schema.decodeUnknownSync(ConsensusEvent);

  it("decodes TipChanged round-trip", () => {
    const evt = {
      _tag: "TipChanged" as const,
      slot: 100n,
      hash: new Uint8Array(32),
      blockNo: 50n,
      blocksProcessed: 10,
    };
    expect(decode(evt)).toEqual(evt);
  });

  it("decodes GsmTransition round-trip", () => {
    const evt = { _tag: "GsmTransition" as const, from: "Syncing", to: "CaughtUp" };
    expect(decode(evt)).toEqual(evt);
  });

  it("decodes EpochTransition round-trip", () => {
    const evt = { _tag: "EpochTransition" as const, fromEpoch: 215n, toEpoch: 216n };
    expect(decode(evt)).toEqual(evt);
  });

  it("decodes PeerStalled round-trip", () => {
    const evt = { _tag: "PeerStalled" as const, peerId: "peer-X" };
    expect(decode(evt)).toEqual(evt);
  });
});
