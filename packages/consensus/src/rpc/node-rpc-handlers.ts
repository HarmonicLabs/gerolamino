/**
 * NodeRpcHandlersLive — server-side handler layer for `NodeRpcGroup`.
 *
 * Wires the 7 Rpcs to their backing services:
 *   - GetChainTip     → ChainDB.getTip
 *   - GetPeers        → PeerManager.getPeers
 *   - GetMempool      → Mempool.snapshot
 *   - GetSyncStatus   → getNodeStatus
 *   - SubmitTx        → Mempool.submit
 *   - SubscribeChainEvents → ChainEventStream.stream (EventLog-backed fan-out)
 *   - SubscribeAtoms  → (placeholder — the Atom bridge lives in
 *                       apps/tui's dashboard; server-side atoms are
 *                       future work)
 *
 * Compose via:
 *   ```ts
 *   RpcServer.layer(NodeRpcGroup).pipe(
 *     Layer.provide(NodeRpcHandlersLive),
 *     Layer.provide(RpcSerialization.layerMsgPack),
 *     Layer.provide(someTransportLayer),
 *   )
 *   ```
 *
 * Transport options per plan Phase 5:
 *   - BunWorkerRunner (apps/tui main-thread ↔ Node Worker)
 *   - WebSocketServer (apps/bootstrap for remote TUI / dashboard clients)
 *   - MessageChannel (future chrome-ext wave)
 */
import { Effect, Option, Stream } from "effect";
import { ChainDB } from "storage";
import { Crypto } from "wasm-utils";
import { ChainEventStream } from "../chain/event-log.ts";
import { Mempool, SubmitResult } from "../mempool/mempool.ts";
import { getNodeStatus } from "../node.ts";
import { PeerManager } from "../peer/manager.ts";
import { ChainTipResult, NodeRpcGroup } from "./node-rpc-group.ts";

/**
 * Handlers live layer. Depends on:
 *   - ChainDB           — tip + immutable tip, block-no lookup.
 *   - PeerManager       — live peer list (tip / status / address).
 *   - Mempool           — submit + snapshot.
 *   - ChainEventStream  — live + historical chain events (EventLog-backed).
 *   - Crypto            — TxId = blake2b-256(txCbor) for SubmitTx.
 *   - getNodeStatus env — the helper itself yields ChainDB + SlotClock +
 *                         PeerManager, so the composed layer reads them
 *                         once at handler-build time and reuses them.
 */
export const NodeRpcHandlersLive = NodeRpcGroup.toLayer(
  Effect.gen(function* () {
    const mempool = yield* Mempool;
    const chainEventStream = yield* ChainEventStream;
    const chainDb = yield* ChainDB;
    const peerManager = yield* PeerManager;
    const crypto = yield* Crypto;

    return NodeRpcGroup.of({
      GetChainTip: () =>
        // ChainDB surfaces the (slot, hash) point; `blockNo` comes from
        // resolving that point to the full StoredBlock. Storage failures
        // collapse to `Option.none()` (with a log) — the RPC has no error
        // payload, and a missing tip is the cold-start state anyway.
        //
        // Shape: `Option<Point> → Effect<Option<ChainTipResult>>` — `None`
        // short-circuits, `Some(point)` fetches the block and maps the row
        // Option straight through (`Option.map` preserves None without a
        // second nested `match`).
        chainDb.getTip.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none<typeof ChainTipResult.Type>()),
              onSome: (point) =>
                chainDb.getBlockAt(point).pipe(
                  Effect.map(
                    Option.map((block): typeof ChainTipResult.Type => ({
                      slot: point.slot,
                      blockNo: block.blockNo,
                      hash: point.hash,
                    })),
                  ),
                ),
            }),
          ),
          Effect.catch((err) =>
            Effect.logWarning(`GetChainTip: ChainDB read failed — ${err.message}`).pipe(
              Effect.as(Option.none()),
            ),
          ),
        ),

      GetPeers: () =>
        peerManager.getPeers.pipe(
          Effect.map((peers) =>
            peers.map((p) => ({
              id: p.peerId,
              address: p.address,
              status: p.status,
              ...(p.tip ? { tipSlot: p.tip.slot } : {}),
            })),
          ),
        ),

      GetMempool: () =>
        mempool.snapshot.pipe(
          Effect.map((entries) =>
            entries.map((e) => ({
              txIdHex: e.txId.toHex(),
              sizeBytes: e.sizeBytes,
              feePerByte: e.feePerByte,
            })),
          ),
          // Mempool.snapshot surfaces `MempoolError` on KV backend failure;
          // the RPC shape has no declared error payload, so swallow to an
          // empty list (operators see `MempoolError` in logs from the
          // underlying storage layer). A future GetMempool update with a
          // declared error channel should propagate instead.
          Effect.catch((err) =>
            // Backend failure (KV down etc.) — `logError` rather than `logWarning`
            // since the empty fallback is otherwise indistinguishable from a
            // legitimately-empty mempool at the caller.
            Effect.logError(`GetMempool: snapshot failed — ${err.message}`).pipe(Effect.as([])),
          ),
        ),

      GetSyncStatus: () =>
        getNodeStatus().pipe(
          Effect.map((status) => ({
            synced: status.gsmState === "CaughtUp",
            slotsBehind: status.currentSlot - status.tipSlot,
            tipSlot: status.tipSlot,
            blocksProcessed: status.blocksProcessed,
          })),
          Effect.catch((err) =>
            // Backend failure — `logError` rather than `logWarning` (default
            // values would otherwise look like a normally-syncing node).
            Effect.logError(`GetSyncStatus: getNodeStatus failed — ${err.message}`).pipe(
              Effect.as({
                synced: false,
                slotsBehind: 0n,
                tipSlot: 0n,
                blocksProcessed: 0,
              }),
            ),
          ),
        ),

      SubmitTx: ({ txCbor }) =>
        // Stub: extract txId as blake2b-256 of the CBOR. Full tx-id
        // computation matches the ledger's `hashTxBody` function;
        // proper wiring lands with Phase 3e Mempool + ledger TxBody
        // decoder integration. Uses the platform-agnostic `Crypto`
        // service so this handler compiles against the browser target.
        Effect.gen(function* () {
          const txId = yield* crypto.blake2b256(txCbor);
          const result = yield* mempool.submit(txId, txCbor, 0n, 0);
          return SubmitResult.match(result, {
            Accepted: () => ({ accepted: true, reason: undefined }),
            Rejected: (r) => ({ accepted: false, reason: r.reasons }),
            AlreadyPresent: () => ({ accepted: false, reason: "already present" }),
          });
        }).pipe(
          Effect.catch((err) =>
            Effect.succeed({ accepted: false, reason: `mempool error: ${String(err)}` }),
          ),
        ),

      SubscribeChainEvents: () =>
        // Handed straight through as the already-composed stream view. The
        // `Uninterruptible: "server"` annotation on the RPC declaration
        // ensures client teardown doesn't kill the underlying source fiber.
        chainEventStream.stream,

      SubscribeAtoms: () =>
        // Placeholder — Atom bridging server-side lives in apps/tui's
        // dashboard adapter. Returns an empty stream for now.
        Stream.empty,
    });
  }),
);
