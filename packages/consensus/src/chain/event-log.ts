/**
 * Chain-level event log, backed by Effect's `EventLog` + `EventJournal`
 * distributed-system primitives (not a bespoke PubSub).
 *
 * Every consensus-accepted state transition — block added, rollback observed,
 * tip advanced, epoch boundary crossed — is written as an `Event` into an
 * `EventLog` whose journal is durable (or in-memory for tests). A single
 * canonical handler fans writes out to an in-process `PubSub` so live
 * in-process subscribers (UI atoms, mempool rollback reaction, NodeRpc
 * streaming) consume a typed `Stream<ChainEventType>` without touching the
 * journal directly. Cold-start replay is exposed via `ChainEventStream.history`
 * which decodes the journal's msgpack-encoded entries back to typed events.
 *
 * The primary API is:
 *   • `writeChainEvent(event)` — `yield*`-able client over `EventLog.write`.
 *   • `ChainEventStream` — `Context.Service` exposing `subscribe` / `stream` /
 *     `history` for live + durable consumers.
 *   • `ChainEventsLive` — fully composed layer (memory journal + encryption
 *     identity + handler + fan-out PubSub); apps/bootstrap swaps the journal
 *     for `SqlEventJournal` at its entrypoint.
 *   • `ChainEventGroup` / `ChainEventLogSchema` — reusable when a remote
 *     replica or cross-process observer needs the same domain.
 *
 * Because `EventLog`'s `registerHandlerUnsafe` is single-handler-per-event
 * (`Map.set` overwrites), multi-subscriber fan-out goes through the internal
 * PubSub rather than multiple registered handlers.
 */
import { Context, Effect, Layer, PubSub, Schema, Scope, Stream } from "effect";
import {
  EventGroup,
  EventJournal,
  EventLog,
  EventLogEncryption,
} from "effect/unstable/eventlog";

// ---------------------------------------------------------------------------
// RollbackTarget — where a rollback points to (real point or origin)
// ---------------------------------------------------------------------------

export const RollbackTarget = Schema.Union([
  Schema.TaggedStruct("RealPoint", {
    slot: Schema.BigInt,
    hash: Schema.Uint8Array,
  }),
  Schema.TaggedStruct("Origin", {}),
]).pipe(Schema.toTaggedUnion("_tag"));

export type RollbackTargetType = typeof RollbackTarget.Type;

// ---------------------------------------------------------------------------
// Per-event tagged structs (referenced by both the ChainEvent union + the
// EventGroup so writers can pass full tagged values and the journal replay
// decodes back to the same shape).
// ---------------------------------------------------------------------------

const BlockAcceptedEvent = Schema.TaggedStruct("BlockAccepted", {
  slot: Schema.BigInt,
  blockNo: Schema.BigInt,
  hash: Schema.Uint8Array,
  parentHash: Schema.Uint8Array,
});

const RolledBackEvent = Schema.TaggedStruct("RolledBack", {
  /** The new chain tip after rollback. */
  to: RollbackTarget,
  /** Number of blocks rolled back — enforced ≤ k (security parameter). */
  depth: Schema.Number,
});

const TipAdvancedEvent = Schema.TaggedStruct("TipAdvanced", {
  slot: Schema.BigInt,
  blockNo: Schema.BigInt,
  hash: Schema.Uint8Array,
});

const EpochBoundaryEvent = Schema.TaggedStruct("EpochBoundary", {
  fromEpoch: Schema.BigInt,
  toEpoch: Schema.BigInt,
  /** The evolved epoch nonce active from `toEpoch` onward. */
  epochNonce: Schema.Uint8Array,
});

/** Tagged union of chain-lifecycle events. */
export const ChainEvent = Schema.Union([
  BlockAcceptedEvent,
  RolledBackEvent,
  TipAdvancedEvent,
  EpochBoundaryEvent,
]).pipe(Schema.toTaggedUnion("_tag"));

export type ChainEventType = typeof ChainEvent.Type;

// ---------------------------------------------------------------------------
// Primary-key helpers — each event has a deterministic idempotency key that
// `EventLog` uses for de-dup + compaction.
// ---------------------------------------------------------------------------

const hexBytes = (h: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < h.length; i++) s += h[i]!.toString(16).padStart(2, "0");
  return s;
};

const rollbackKey = (payload: typeof RolledBackEvent.Type): string =>
  payload.to._tag === "Origin"
    ? "origin"
    : `${payload.to.slot}:${hexBytes(payload.to.hash)}`;

// ---------------------------------------------------------------------------
// EventGroup — the domain of events for the log
// ---------------------------------------------------------------------------

export const ChainEventGroup = EventGroup.empty
  .add({
    tag: "BlockAccepted",
    primaryKey: (payload: typeof BlockAcceptedEvent.Type) => hexBytes(payload.hash),
    payload: BlockAcceptedEvent,
  })
  .add({
    tag: "RolledBack",
    primaryKey: rollbackKey,
    payload: RolledBackEvent,
  })
  .add({
    tag: "TipAdvanced",
    primaryKey: (payload: typeof TipAdvancedEvent.Type) => hexBytes(payload.hash),
    payload: TipAdvancedEvent,
  })
  .add({
    tag: "EpochBoundary",
    primaryKey: (payload: typeof EpochBoundaryEvent.Type) => payload.toEpoch.toString(),
    payload: EpochBoundaryEvent,
  });

/** Schema token passed to `EventLog.write`. */
export const ChainEventLogSchema = EventLog.schema(ChainEventGroup);

// ---------------------------------------------------------------------------
// Writer — `yield*`-able convenience wrapping `EventLog.write` for the
// tagged-union payload. Callers pass a fully-tagged `ChainEventType`; we
// route by `_tag` to the appropriate event.
// ---------------------------------------------------------------------------

export const writeChainEvent = (event: ChainEventType) =>
  Effect.gen(function* () {
    const log = yield* EventLog.EventLog;
    return yield* ChainEvent.match(event, {
      BlockAccepted: (payload) =>
        log.write({ schema: ChainEventLogSchema, event: "BlockAccepted", payload }),
      RolledBack: (payload) =>
        log.write({ schema: ChainEventLogSchema, event: "RolledBack", payload }),
      TipAdvanced: (payload) =>
        log.write({ schema: ChainEventLogSchema, event: "TipAdvanced", payload }),
      EpochBoundary: (payload) =>
        log.write({ schema: ChainEventLogSchema, event: "EpochBoundary", payload }),
    });
  });

// ---------------------------------------------------------------------------
// ChainEventPubSub — internal fan-out PubSub shared between the canonical
// EventLog handler and any in-process live subscriber. Made `Context.Service`
// so the handler layer can `yield*` it; not re-exported because consumers
// should go through `ChainEventStream`.
// ---------------------------------------------------------------------------

class ChainEventPubSub extends Context.Service<
  ChainEventPubSub,
  PubSub.PubSub<ChainEventType>
>()("consensus/ChainEventPubSub") {}

const ChainEventPubSubLive = Layer.effect(
  ChainEventPubSub,
  PubSub.bounded<ChainEventType>(256),
);

// ---------------------------------------------------------------------------
// ChainEventStream — the public subscribe surface. Exposes scoped
// subscription, a `Stream` view, and a `history` replay that decodes every
// journal entry back to its typed `ChainEventType`.
// ---------------------------------------------------------------------------

export class ChainEventStream extends Context.Service<
  ChainEventStream,
  {
    /**
     * Scoped subscription handle. Paired with `PubSub.take` /
     * `PubSub.takeAll` / `PubSub.takeBetween`. Matches the canonical
     * `effect/test/PubSub.test.ts` pattern.
     */
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<ChainEventType>,
      never,
      Scope.Scope
    >;

    /** High-level `Stream` view — convenience for `.pipe(Stream.filter, ...)`. */
    readonly stream: Stream.Stream<ChainEventType>;

    /**
     * Decoded durable history from the underlying `EventJournal`. Each
     * entry's msgpack payload is decoded through the matching event's
     * `payloadMsgPack` schema.
     */
    readonly history: Effect.Effect<
      ReadonlyArray<ChainEventType>,
      EventJournal.EventJournalError | Schema.SchemaError
    >;
  }
>()("consensus/ChainEventStream") {}

// ---------------------------------------------------------------------------
// Handler layer — the canonical one-handler-per-event that publishes each
// decoded payload to the fan-out PubSub. Registered via `EventLog.group`.
// ---------------------------------------------------------------------------

const publishTo = (event: ChainEventType) =>
  Effect.gen(function* () {
    const pubsub = yield* ChainEventPubSub;
    yield* PubSub.publish(pubsub, event);
  });

const handlerLayer = EventLog.group(ChainEventGroup, (handlers) =>
  handlers
    .handle("BlockAccepted", ({ payload }) => publishTo(payload))
    .handle("RolledBack", ({ payload }) => publishTo(payload))
    .handle("TipAdvanced", ({ payload }) => publishTo(payload))
    .handle("EpochBoundary", ({ payload }) => publishTo(payload)),
);

// ---------------------------------------------------------------------------
// ChainEventStream service layer — builds `subscribe` / `stream` / `history`
// against the shared PubSub + underlying EventLog.
// ---------------------------------------------------------------------------

const ChainEventStreamLive = Layer.effect(
  ChainEventStream,
  Effect.gen(function* () {
    const pubsub = yield* ChainEventPubSub;
    const log = yield* EventLog.EventLog;

    // Per-tag payload decoders pulled from the EventGroup's `payloadMsgPack`.
    const events = ChainEventGroup.events;
    const decodeByTag = (tag: string, payload: Uint8Array) => {
      const event = events[tag];
      if (!event) return Effect.fail(new DecodedUnknownEventError({ tag }));
      return Schema.decodeUnknownEffect(event.payloadMsgPack)(payload);
    };

    return ChainEventStream.of({
      subscribe: PubSub.subscribe(pubsub),
      stream: Stream.fromPubSub(pubsub),
      history: Effect.flatMap(log.entries, (entries) =>
        Effect.forEach(entries, (entry) =>
          decodeByTag(entry.event, entry.payload).pipe(
            Effect.map((decoded) => decoded as ChainEventType),
          ),
        ),
      ),
    });
  }),
);

// Sentinel error for unknown event tag in the journal — only fires when a
// stale journal is replayed against a new schema version.
class DecodedUnknownEventError extends Schema.TaggedErrorClass<DecodedUnknownEventError>()(
  "DecodedUnknownEventError",
  { tag: Schema.String },
) {}

// ---------------------------------------------------------------------------
// Identity layer — EventLog requires an `Identity` for write authorship. The
// encryption-subtle variant uses the runtime's `crypto.subtle` (native in
// Bun), and `EventLog.makeIdentity` derives a fresh keypair on layer boot.
// ---------------------------------------------------------------------------

const IdentityLive = Layer.effect(EventLog.Identity, EventLog.makeIdentity).pipe(
  Layer.provide(EventLogEncryption.layerSubtle),
);

// ---------------------------------------------------------------------------
// Fully composed live layer — memory journal. Apps that want durable
// persistence provide `SqlEventJournal.layer({ schema: "event_journal" })`
// in place of `EventJournal.layerMemory` at their entrypoint.
// ---------------------------------------------------------------------------

/**
 * `ChainEventsLive` — full composition for in-memory tests + dev nodes.
 *
 * Outputs: `ChainEventStream | EventLog.EventLog | EventLog.Registry`.
 *
 * Requires: nothing (self-contained; `EventJournal.layerMemory`,
 * `EventLogEncryption.layerSubtle`, and `EventLog.Identity` are all
 * provided internally).
 *
 * For apps/bootstrap: swap `EventJournal.layerMemory` for
 * `SqlEventJournal.layer(...)` when composing the app's root layer.
 *
 * Composition shape: `ChainEventStreamLive` consumes `EventLog.EventLog`
 * (for `.history`) and `ChainEventPubSub` (for the fan-out). `provideMerge`
 * keeps `EventLog | Registry` as outputs of the final layer while making
 * them visible to `ChainEventStreamLive`'s body; the shared
 * `ChainEventPubSub` makes it into the handler layer via the inner
 * `EventLog.layer(...)` provideMerge chain.
 */
export const ChainEventsLive = ChainEventStreamLive.pipe(
  Layer.provideMerge(EventLog.layer(ChainEventLogSchema, handlerLayer)),
  Layer.provide(ChainEventPubSubLive),
  Layer.provide(EventJournal.layerMemory),
  Layer.provide(IdentityLive),
);
