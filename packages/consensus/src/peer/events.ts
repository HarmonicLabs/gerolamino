/**
 * ConsensusEvents — typed PubSub event bus for consensus-layer notifications.
 *
 * Consumers (TUI dashboard, chrome-ext popup) subscribe to receive real-time
 * events about chain tip changes, epoch transitions, GSM state changes, and
 * peer stall detections without polling.
 *
 * Producers emit events from:
 *   - chain-sync-driver.ts → TipChanged, EpochTransition
 *   - node.ts → GsmTransition
 *   - peer-manager.ts → PeerStalled
 */
import { Context, Effect, Layer, PubSub, Schema, Scope } from "effect";
import type { GsmState } from "../chain/selection";

export enum ConsensusEventKind {
  TipChanged = "TipChanged",
  GsmTransition = "GsmTransition",
  EpochTransition = "EpochTransition",
  PeerStalled = "PeerStalled",
}

export const ConsensusEvent = Schema.Union([
  Schema.TaggedStruct(ConsensusEventKind.TipChanged, {
    slot: Schema.BigInt,
    hash: Schema.Uint8Array,
    blockNo: Schema.BigInt,
    blocksProcessed: Schema.Number,
  }),
  Schema.TaggedStruct(ConsensusEventKind.GsmTransition, {
    from: Schema.String,
    to: Schema.String,
  }),
  Schema.TaggedStruct(ConsensusEventKind.EpochTransition, {
    fromEpoch: Schema.BigInt,
    toEpoch: Schema.BigInt,
  }),
  Schema.TaggedStruct(ConsensusEventKind.PeerStalled, {
    peerId: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type ConsensusEventType = typeof ConsensusEvent.Type;

export class ConsensusEvents extends Context.Service<
  ConsensusEvents,
  {
    /** Publish an event to all subscribers. */
    readonly emit: (event: ConsensusEventType) => Effect.Effect<void>;
    /** Subscribe to receive consensus events. Subscription auto-cleans on scope exit. */
    readonly subscribe: Effect.Effect<PubSub.Subscription<ConsensusEventType>, never, Scope.Scope>;
  }
>()("consensus/ConsensusEvents") {
  static readonly Live = Layer.effect(
    ConsensusEvents,
    Effect.gen(function* () {
      // `sliding(256)` keeps the newest events and drops oldest when full —
      // matches UI-consumer semantics where the dashboard only cares about
      // the latest tip / GSM transition. `unbounded` previously let memory
      // grow without bound when a paused popup never drained its queue.
      const pubsub = yield* PubSub.sliding<ConsensusEventType>(256);

      return ConsensusEvents.of({
        emit: (event) => PubSub.publish(pubsub, event),
        subscribe: PubSub.subscribe(pubsub),
      });
    }),
  );
}
