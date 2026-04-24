/**
 * `PeerHandlersLive` — concrete handler layer for the `Peer` Cluster
 * Entity declared in `Peer.ts`.
 *
 * Full protocol wiring (the stubs that previously lived here — `RequestBlocks`
 * returning `[]`, `SubmitTx` auto-accepting — are gone):
 *
 *   - `ConnectToPeer` opens a real bearer via `PeerConnectionFactory`
 *     (platform-agnostic service — apps/tui wires `BunSocket.layerNet`,
 *     chrome-ext wires `BrowserSocket`). The factory composes
 *     `Multiplexer.layer` + `HandshakeClient.layer` +
 *     `BlockFetchClient.layer` + `TxSubmissionClient.layer` on top of the
 *     socket, runs handshake, forks the TxSubmissionClient loop inside the
 *     connection's scope, and returns a `PeerConnectionHandle` with
 *     already-bound `fetchBlocks` and `queueTx` closures.
 *
 *   - `RequestBlocks` looks up the per-peer handle in `PeerConnections`,
 *     calls `fetchBlocks`, collects the returned stream to a readonly
 *     array of block CBOR bytes.
 *
 *   - `SubmitTx` looks up the handle and pushes the tx onto the
 *     connection's outbound queue. The forked `TxSubmissionClient.run`
 *     drains the queue when the remote peer sends `MsgRequestTxIds` /
 *     `MsgRequestTxs`. Returns `Rejected` if no open connection exists
 *     (the handle is owned by the entity's `Disconnect`-bounded scope).
 *
 *   - `Disconnect` closes the per-peer scope, which cascades through the
 *     multiplexer and the socket's own finalizer.
 *
 * State model:
 *   - Persisted cursor: `KeyValueStore` under `peer:cursor:<entityId>`.
 *     The `AdvanceCursor` RPC is `ClusterSchema.Persisted` so Cluster
 *     replays it on reactivation; the KV mirror makes `GetCursor` a
 *     synchronous read.
 *   - Live connection handle: kept in `PeerConnections` (a process-local
 *     `Ref<HashMap<PeerId, …>>`) with its own `Scope.Closeable` so
 *     `Disconnect` can tear one peer down without touching others.
 */
import {
  Clock,
  Context,
  Effect,
  Exit,
  HashMap,
  Layer,
  Metric,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import type { Cause } from "effect";
import type { Socket } from "effect/unstable/socket";
import { KeyValueStore } from "effect/unstable/persistence";

import { peerCount, peerMessagesIn, peerMessagesOut } from "../Metrics";
import { Multiplexer } from "../multiplexer/Multiplexer";
import { MultiplexerBuffer } from "../multiplexer/Buffer";
import { BlockFetchClient } from "../protocols/block-fetch/Client";
import { HandshakeClient } from "../protocols/handshake/Client";
import {
  HandshakeMessage,
  HandshakeMessageType,
  NodeToNodeVersionDataSchema,
} from "../protocols/handshake/Schemas";
import type { NodeToNodeVersionData, VersionTable } from "../protocols/handshake/Schemas";
import { TxSubmissionClient, type TxSubmissionHandlers } from "../protocols/tx-submission/Client";
import type { TxIdAndSize } from "../protocols/tx-submission/Schemas";
import { ChainPointSchema, type ChainPoint } from "../protocols/types/ChainPoint";

import {
  AdvanceCursor,
  ConnectToPeer,
  Disconnect,
  GetCursor,
  Peer,
  PeerError,
  PeerEndpoint,
  PeerId,
  RequestBlocks,
  SubmitOutcome,
  SubmitTx,
} from "./Peer";

// ═══════════════════════════════════════════════════════════════════════
// PeerMeta + PeerRegistry — unchanged from the stub-era implementation.
// ═══════════════════════════════════════════════════════════════════════

/** Public-facing peer metadata. */
export const PeerMeta = Schema.Struct({
  host: Schema.String,
  port: Schema.Number,
  networkMagic: Schema.Number,
  connectedAtMs: Schema.Number,
  cursorSlot: Schema.OptionFromNullOr(Schema.BigInt),
});
export type PeerMeta = typeof PeerMeta.Type;

export class PeerRegistry extends Context.Service<
  PeerRegistry,
  {
    readonly peers: SubscriptionRef.SubscriptionRef<HashMap.HashMap<PeerId, PeerMeta>>;
    readonly changes: Stream.Stream<HashMap.HashMap<PeerId, PeerMeta>>;
    readonly snapshot: Effect.Effect<
      ReadonlyArray<{ readonly id: PeerId; readonly meta: PeerMeta }>
    >;
    readonly register: (id: PeerId, meta: PeerMeta) => Effect.Effect<void>;
    readonly deregister: (id: PeerId) => Effect.Effect<void>;
  }
>()("peer/PeerRegistry") {}

export const PeerRegistryLive: Layer.Layer<PeerRegistry> = Layer.effect(
  PeerRegistry,
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make<HashMap.HashMap<PeerId, PeerMeta>>(HashMap.empty());
    return PeerRegistry.of({
      peers: ref,
      changes: SubscriptionRef.changes(ref),
      snapshot: SubscriptionRef.get(ref).pipe(
        Effect.map((hm) => Array.from(hm, ([id, meta]) => ({ id, meta }))),
      ),
      register: (id, meta) => SubscriptionRef.update(ref, HashMap.set(id, meta)),
      deregister: (id) => SubscriptionRef.update(ref, HashMap.remove(id)),
    });
  }),
);

// ═══════════════════════════════════════════════════════════════════════
// PeerConnectionHandle — live per-peer operations.
//
// Produced by `PeerConnectionFactory.open`; held by `PeerConnections`
// while the bearer is live; torn down by closing the associated scope.
// Error channel collapses every underlying protocol/transport failure to
// `PeerError` so the Rpc layer's declared error type stays honest.
// ═══════════════════════════════════════════════════════════════════════

export interface PeerConnectionHandle {
  /** Remote-accepted handshake version data (for telemetry). */
  readonly versionInfo: { readonly version: number; readonly data: NodeToNodeVersionData };
  /**
   * Range-fetch blocks from the remote peer. Errors collapse to
   * `PeerError`; the stream is fully drained inside this call, so no
   * `Scope` requirement leaks into the caller's environment.
   */
  readonly fetchBlocks: (
    from: ChainPoint,
    to: ChainPoint,
  ) => Effect.Effect<ReadonlyArray<Uint8Array>, PeerError>;
  /** Enqueue a tx for eventual pull by the remote's TxSubmission2 loop. */
  readonly queueTx: (txId: Uint8Array, txCbor: Uint8Array) => Effect.Effect<void>;
  /** Signal the TxSubmission2 server that no more txs will be queued. */
  readonly finishTxSubmission: Effect.Effect<void>;
}

// ═══════════════════════════════════════════════════════════════════════
// SocketLayerFactory — the only platform-agnostic seam.
//
// Given a `PeerEndpoint`, produce a `Socket`-providing `Layer`. Apps
// wire `BunSocket.layerNet` (bun), `NodeSocket.layerNet` (node), or
// `BrowserSocket.layer` (chrome-ext) once; the rest of the connection
// machinery below is transport-agnostic.
// ═══════════════════════════════════════════════════════════════════════

export class SocketLayerFactory extends Context.Service<
  SocketLayerFactory,
  {
    readonly forEndpoint: (
      endpoint: PeerEndpoint,
    ) => Layer.Layer<Socket.Socket, Socket.SocketError>;
  }
>()("peer/SocketLayerFactory") {}

// ═══════════════════════════════════════════════════════════════════════
// PeerConnectionFactory — opens a live handle from an endpoint.
//
// The Live layer runs the full protocol stack:
//   1. Layer.build  → Multiplexer + HandshakeClient + BlockFetchClient +
//                     TxSubmissionClient, all riding the provided Socket.
//   2. Handshake    → propose N2N v14, fail on refuse/unexpected.
//   3. Outbound    → Queue + id-indexed map for TxSubmission2 server-pulls.
//   4. Fork        → TxSubmissionClient.run(handlers) inside the factory's
//                    scope; fiber dies when the scope closes.
//   5. Handle      → each operation is pre-`Effect.provide`-d with the
//                    built context so consumers don't see transport types.
// ═══════════════════════════════════════════════════════════════════════

export class PeerConnectionFactory extends Context.Service<
  PeerConnectionFactory,
  {
    readonly open: (
      endpoint: PeerEndpoint,
    ) => Effect.Effect<PeerConnectionHandle, PeerError, Scope.Scope>;
  }
>()("peer/PeerConnectionFactory") {}

/** Build the N2N v14 version table for a given endpoint. */
const buildN2NVersionTable = (endpoint: PeerEndpoint): VersionTable => ({
  _tag: "node-to-node",
  data: {
    14: {
      networkMagic: endpoint.networkMagic,
      initiatorOnlyDiffusionMode: false,
      peerSharing: 0,
      query: false,
    },
  },
});

const peerErr = (reason: string, cause?: unknown): PeerError =>
  new PeerError({ reason: cause === undefined ? reason : `${reason}: ${String(cause)}` });

const toPeerError = (reason: string) => (cause: unknown) => peerErr(reason, cause);

/**
 * Live `PeerConnectionFactory`. Depends on `SocketLayerFactory` so it
 * stays platform-agnostic — the only platform-specific call is
 * `socketFactory.forEndpoint(endpoint)`.
 */
export const PeerConnectionFactoryLive: Layer.Layer<
  PeerConnectionFactory,
  never,
  SocketLayerFactory
> = Layer.effect(
  PeerConnectionFactory,
  Effect.gen(function* () {
    const socketFactory = yield* SocketLayerFactory;

    const open = (
      endpoint: PeerEndpoint,
    ): Effect.Effect<PeerConnectionHandle, PeerError, Scope.Scope> =>
      Effect.gen(function* () {
        // Compose the full bearer-side stack. Everything shares one
        // multiplexer + one socket (the outer scope, provided by the
        // caller, owns all three).
        const socketLayer = socketFactory.forEndpoint(endpoint);
        const multiplexerLayer = Multiplexer.layer.pipe(
          Layer.provide(MultiplexerBuffer.layer),
          Layer.provide(socketLayer),
        );
        const clientsLayer = Layer.mergeAll(
          HandshakeClient.layer,
          BlockFetchClient.layer,
          TxSubmissionClient.layer,
        ).pipe(Layer.provide(multiplexerLayer));

        const context = yield* Layer.build(clientsLayer).pipe(
          Effect.mapError(toPeerError("transport-layer build failed")),
        );

        const hsClient = Context.get(context, HandshakeClient);
        const bfClient = Context.get(context, BlockFetchClient);
        const txClient = Context.get(context, TxSubmissionClient);

        // ── Handshake ──
        const versionTable = buildN2NVersionTable(endpoint);
        const hsReply = yield* Effect.provide(hsClient.propose(versionTable), context).pipe(
          Effect.mapError(toPeerError("handshake failed")),
        );
        // The Schema-level `versionData` field is a union of N2N and N2C
        // shapes. We proposed an N2N version table, so the accepted reply
        // must carry N2N data; narrowing is a runtime schema-guard, not
        // a cast (`Schema.is(NodeToNodeVersionDataSchema)` tests + narrows
        // in the type system).
        const isN2NData = Schema.is(NodeToNodeVersionDataSchema);
        const versionInfo = yield* HandshakeMessage.match(hsReply, {
          [HandshakeMessageType.MsgAcceptVersion]: (m) =>
            isN2NData(m.versionData)
              ? Effect.succeed({ version: m.version, data: m.versionData })
              : Effect.fail(peerErr("handshake returned N2C version data for an N2N proposal")),
          [HandshakeMessageType.MsgRefuse]: (m) =>
            Effect.fail(peerErr(`handshake refused by peer: ${JSON.stringify(m.reason)}`)),
          [HandshakeMessageType.MsgProposeVersions]: () =>
            Effect.fail(peerErr("handshake protocol violation: server echoed MsgProposeVersions")),
          [HandshakeMessageType.MsgQueryReply]: () =>
            Effect.fail(peerErr("handshake returned MsgQueryReply (query mode not requested)")),
        });

        // ── TxSubmission2 outbound buffer ──
        // Bounded at the Ouroboros `MAX_UNACKED_TX_IDS` = 10 window; the
        // server pulls via `RequestTxIds` / `RequestTxs`. Keeping the
        // queue small is deliberate — submitters should feel back-pressure
        // when the peer isn't draining, rather than accumulating.
        const outboundQueue = yield* Queue.bounded<TxIdAndSize>(16);
        const outboundById = yield* Ref.make(HashMap.empty<string, Uint8Array>());
        const outboundDone = yield* Ref.make(false);

        const onRequestTxIds = (
          _ack: number,
          req: number,
          blocking: boolean,
        ): Effect.Effect<ReadonlyArray<TxIdAndSize>> =>
          Effect.gen(function* () {
            // In blocking mode, wait for at least one id — the peer will
            // park until we return. In non-blocking mode, take whatever's
            // queued and return (possibly empty).
            if (blocking) {
              const head = yield* Queue.take(outboundQueue);
              const rest = yield* drainUpTo(outboundQueue, Math.max(0, req - 1));
              return [head, ...rest];
            }
            return yield* drainUpTo(outboundQueue, req);
          });

        const onRequestTxs = (
          txIds: ReadonlyArray<Uint8Array>,
        ): Effect.Effect<ReadonlyArray<Uint8Array>> =>
          Ref.get(outboundById).pipe(Effect.map((byId) => collectTxs(byId, txIds)));

        const txHandlers: TxSubmissionHandlers = { onRequestTxIds, onRequestTxs };

        // Fork the TxSubmission2 server loop into the factory's scope.
        // When the caller closes the scope (via `Disconnect`), the fiber
        // is interrupted and the underlying channel.sendDone fires.
        yield* Effect.forkScoped(
          Effect.provide(txClient.run(txHandlers), context).pipe(
            // A fatal tx-submission error terminates the loop cleanly;
            // the peer will observe the bearer close + reconnect. We
            // log but don't propagate — the peer handler's scope close
            // is the authoritative "stop me" signal.
            Effect.catchCause((cause: Cause.Cause<unknown>) =>
              Effect.logWarning("TxSubmissionClient.run exited").pipe(
                Effect.annotateLogs({
                  host: endpoint.host,
                  port: endpoint.port,
                  cause: String(cause),
                }),
              ),
            ),
          ),
        );

        const fetchBlocks: PeerConnectionHandle["fetchBlocks"] = (from, to) =>
          Effect.provide(bfClient.requestRange(from, to), context).pipe(
            Effect.mapError(toPeerError("requestRange failed")),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed<ReadonlyArray<Uint8Array>>([]),
                onSome: (stream) =>
                  Stream.runCollect(stream).pipe(
                    Effect.mapError(toPeerError("block stream failed")),
                  ),
              }),
            ),
            Effect.tap((blocks) =>
              blocks.length > 0 ? Metric.update(peerMessagesIn, blocks.length) : Effect.void,
            ),
            // Fresh per-call scope so the stream's ownership is bounded
            // to this fetchBlocks invocation, not the caller's scope.
            Effect.scoped,
          );

        const queueTx: PeerConnectionHandle["queueTx"] = (txId, txCbor) =>
          Ref.get(outboundDone).pipe(
            Effect.flatMap((done) =>
              done
                ? Effect.void // tx-submission closed — accept silently; caller treats as Rejected at the RPC layer
                : Effect.all(
                    [
                      Ref.update(outboundById, HashMap.set(txId.toHex(), txCbor)),
                      Queue.offer(outboundQueue, { txId, size: txCbor.byteLength }),
                      Metric.update(peerMessagesOut, 1),
                    ],
                    { discard: true },
                  ),
            ),
          );

        const finishTxSubmission: Effect.Effect<void> = Effect.all(
          [
            Ref.set(outboundDone, true),
            Queue.shutdown(outboundQueue),
            Effect.provide(txClient.done(), context).pipe(
              Effect.scoped,
              Effect.catchCause((cause: Cause.Cause<unknown>) =>
                Effect.logDebug("TxSubmission done() failed — likely already closed").pipe(
                  Effect.annotateLogs({ cause: String(cause) }),
                ),
              ),
            ),
          ],
          { discard: true },
        );

        return { versionInfo, fetchBlocks, queueTx, finishTxSubmission };
      });

    return PeerConnectionFactory.of({ open });
  }),
);

/**
 * Drain up to `n` items out of a bounded Queue without blocking.
 * `Queue.takeAll` returns a Chunk of everything currently queued; we
 * trim to `n`. If the queue is empty, returns `[]`.
 */
const drainUpTo = <A>(queue: Queue.Queue<A>, n: number): Effect.Effect<ReadonlyArray<A>> =>
  n <= 0 ? Effect.succeed([]) : Queue.takeBetween(queue, 0, n);

/**
 * Project an array of tx-ids through the outbound-by-id map. Preserves
 * input order; missing ids (already-acked, evicted) are omitted — the
 * remote treats a short reply as "those txs are gone from my pool."
 */
const collectTxs = (
  byId: HashMap.HashMap<string, Uint8Array>,
  txIds: ReadonlyArray<Uint8Array>,
): ReadonlyArray<Uint8Array> =>
  txIds.reduce<ReadonlyArray<Uint8Array>>((acc, id) => {
    const hit = HashMap.get(byId, id.toHex());
    return Option.isSome(hit) ? [...acc, hit.value] : acc;
  }, []);

// ═══════════════════════════════════════════════════════════════════════
// PeerConnections — process-local registry of live handles keyed by
// PeerId. Each entry owns its own sub-scope so `close(id)` rolls just
// that one peer's bearer.
// ═══════════════════════════════════════════════════════════════════════

interface ConnectionEntry {
  readonly handle: PeerConnectionHandle;
  readonly scope: Scope.Closeable;
}

export class PeerConnections extends Context.Service<
  PeerConnections,
  {
    readonly open: (
      id: PeerId,
      endpoint: PeerEndpoint,
    ) => Effect.Effect<PeerConnectionHandle, PeerError>;
    readonly get: (id: PeerId) => Effect.Effect<Option.Option<PeerConnectionHandle>>;
    readonly close: (id: PeerId) => Effect.Effect<void>;
  }
>()("peer/PeerConnections") {}

export const PeerConnectionsLive: Layer.Layer<PeerConnections, never, PeerConnectionFactory> =
  Layer.effect(
    PeerConnections,
    Effect.gen(function* () {
      const factory = yield* PeerConnectionFactory;
      const entries = yield* Ref.make(HashMap.empty<string, ConnectionEntry>());
      const parentScope = yield* Effect.scope;

      const closeEntry = (entry: ConnectionEntry): Effect.Effect<void> =>
        Scope.close(entry.scope, Exit.void);

      // Outer-scope finalizer: tear down every live entry on runtime exit.
      // Without this a crash leaks bearer sockets + TxSubmission fibers.
      yield* Scope.addFinalizer(
        parentScope,
        Ref.get(entries).pipe(
          Effect.flatMap((map) =>
            Effect.forEach(HashMap.values(map), closeEntry, {
              discard: true,
              concurrency: "unbounded",
            }),
          ),
        ),
      );

      const open = (
        id: PeerId,
        endpoint: PeerEndpoint,
      ): Effect.Effect<PeerConnectionHandle, PeerError> =>
        Effect.gen(function* () {
          // If already open, return the existing handle — `ConnectToPeer`
          // is idempotent by design (Cluster entity message dedup + user
          // re-issuing a connect during a reconnect storm).
          const existing = yield* Ref.get(entries).pipe(Effect.map(HashMap.get(id.value)));
          if (Option.isSome(existing)) return existing.value.handle;

          // Fresh child scope of the service's outer scope so runtime
          // shutdown still cascades, but we can close this one peer
          // independently.
          const scope = yield* Scope.fork(parentScope);
          const handle = yield* factory.open(endpoint).pipe(
            Scope.provide(scope),
            // If the factory fails, close the half-built scope before
            // propagating so we don't leak the socket finalizer.
            Effect.tapCause(() => Scope.close(scope, Exit.void)),
          );
          yield* Ref.update(entries, HashMap.set(id.value, { handle, scope }));
          return handle;
        });

      const get = (id: PeerId): Effect.Effect<Option.Option<PeerConnectionHandle>> =>
        Ref.get(entries).pipe(
          Effect.map((map) => HashMap.get(map, id.value).pipe(Option.map((e) => e.handle))),
        );

      const close = (id: PeerId): Effect.Effect<void> =>
        Ref.modify(entries, (map) => {
          const entry = HashMap.get(map, id.value);
          return Option.isSome(entry)
            ? [Option.some(entry.value), HashMap.remove(map, id.value)]
            : [Option.none<ConnectionEntry>(), map];
        }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: closeEntry,
            }),
          ),
        );

      return PeerConnections.of({ open, get, close });
    }),
  );

// ═══════════════════════════════════════════════════════════════════════
// KV helpers for the persisted ChainSync cursor.
// ═══════════════════════════════════════════════════════════════════════

const cursorKey = (entityId: string): string => `peer:cursor:${entityId}`;
const entityIdToPeerId = (entityId: string): PeerId => new PeerId({ value: entityId });

// ═══════════════════════════════════════════════════════════════════════
// PeerHandlersLive — the concrete Entity handler layer.
// ═══════════════════════════════════════════════════════════════════════

export const PeerHandlersLive = Peer.toLayer(
  Effect.gen(function* () {
    const kv = yield* KeyValueStore.KeyValueStore;
    const registry = yield* PeerRegistry;
    const connections = yield* PeerConnections;

    // Schema-validated JSON codec for the persisted cursor — structural
    // validation on read + canonical serialisation on write, so a
    // schema drift between runs surfaces as a typed SchemaError rather
    // than a silent `JSON.parse(raw) as ChainPoint` miscast.
    const CursorJson = Schema.fromJsonString(ChainPointSchema);
    const decodeCursor = Schema.decodeUnknownEffect(CursorJson);
    const encodeCursor = Schema.encodeUnknownEffect(CursorJson);

    const readCursor = (entityId: string): Effect.Effect<Option.Option<ChainPoint>> =>
      kv.get(cursorKey(entityId)).pipe(
        Effect.flatMap((raw) =>
          raw === undefined
            ? Effect.succeed(Option.none<ChainPoint>())
            : decodeCursor(raw).pipe(
                Effect.map(Option.some),
                // Corrupted / stale-schema cursor is indistinguishable
                // from "no cursor" from the peer's perspective — the
                // next FindIntersect restarts from genesis either way.
                Effect.catch((cause) =>
                  Effect.logWarning("peer.cursor: schema-mismatch on reactivation, resetting").pipe(
                    Effect.annotateLogs({ entityId, cause: String(cause) }),
                    Effect.as(Option.none<ChainPoint>()),
                  ),
                ),
              ),
        ),
        Effect.orDie,
      );

    const writeCursor = (entityId: string, point: ChainPoint): Effect.Effect<void> =>
      encodeCursor(point).pipe(
        Effect.flatMap((raw) => kv.set(cursorKey(entityId), raw)),
        Effect.orDie,
      );

    const rebuildPeerCountGauge: Effect.Effect<void> = SubscriptionRef.get(registry.peers).pipe(
      Effect.flatMap((hm) => Metric.update(peerCount, HashMap.size(hm))),
    );

    return {
      ConnectToPeer: (env) =>
        Effect.gen(function* () {
          const id = entityIdToPeerId(env.address.entityId);
          const now = yield* Clock.currentTimeMillis;
          yield* connections.open(id, env.payload.address);
          yield* registry.register(id, {
            host: env.payload.address.host,
            port: env.payload.address.port,
            networkMagic: env.payload.address.networkMagic,
            connectedAtMs: now,
            cursorSlot: Option.none(),
          });
          yield* rebuildPeerCountGauge;
          return id;
        }).pipe(Effect.withSpan("peer.handler.connect")),

      AdvanceCursor: (env) =>
        writeCursor(env.address.entityId, env.payload.point).pipe(
          Effect.tap(() => Metric.update(peerMessagesIn, 1)),
          Effect.as({ ok: true }),
          Effect.withSpan("peer.handler.advance_cursor"),
        ),

      GetCursor: (env) =>
        readCursor(env.address.entityId).pipe(
          Effect.map(Option.getOrNull),
          Effect.withSpan("peer.handler.get_cursor"),
        ),

      RequestBlocks: (env) =>
        Effect.gen(function* () {
          const id = entityIdToPeerId(env.address.entityId);
          const handleOpt = yield* connections.get(id);
          const handle = yield* Option.match(handleOpt, {
            onNone: () => Effect.fail(peerErr(`no open connection for peer ${id.value}`)),
            onSome: (h) => Effect.succeed(h),
          });
          return yield* handle.fetchBlocks(env.payload.from, env.payload.to);
        }).pipe(Effect.scoped, Effect.withSpan("peer.handler.request_blocks")),

      SubmitTx: (env) =>
        Effect.gen(function* () {
          const id = entityIdToPeerId(env.address.entityId);
          const handleOpt = yield* connections.get(id);
          return yield* Option.match(handleOpt, {
            onNone: () =>
              Effect.succeed<SubmitOutcome>({
                _tag: "Rejected",
                txId: env.payload.txId,
                reason: `no open connection for peer ${id.value}`,
              }),
            onSome: (h) =>
              h
                .queueTx(env.payload.txId, env.payload.txCbor)
                .pipe(Effect.as<SubmitOutcome>({ _tag: "Accepted", txId: env.payload.txId })),
          });
        }).pipe(Effect.withSpan("peer.handler.submit_tx")),

      Disconnect: (env) =>
        Effect.gen(function* () {
          const id = entityIdToPeerId(env.address.entityId);
          // Best-effort: finish TxSubmission cleanly before closing the
          // bearer so the peer doesn't see a mid-roundtrip socket drop.
          const handleOpt = yield* connections.get(id);
          yield* Option.match(handleOpt, {
            onNone: () => Effect.void,
            onSome: (h) => h.finishTxSubmission,
          });
          yield* connections.close(id);
          yield* registry.deregister(id);
          yield* rebuildPeerCountGauge;
          return { ok: true };
        }).pipe(Effect.withSpan("peer.handler.disconnect")),
    };
  }),
);

// ═══════════════════════════════════════════════════════════════════════
// Utilities re-exported alongside the handlers for consumer ergonomics.
// ═══════════════════════════════════════════════════════════════════════

/** Typed `PeerError` rejection for consumers that want a uniform surface. */
export const rejectPeer = (reason: string): Effect.Effect<never, PeerError> =>
  Effect.fail(new PeerError({ reason }));

// Re-export the RPC class-objects + Entity so callers can pull everything
// through `./handler.ts` without reaching into `./Peer.ts` directly.
export { AdvanceCursor, ConnectToPeer, Disconnect, GetCursor, Peer, RequestBlocks, SubmitTx };
