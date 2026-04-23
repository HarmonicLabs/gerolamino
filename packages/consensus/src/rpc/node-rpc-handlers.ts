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
import { ChainEventStream } from "../chain/event-log.ts";
import { Mempool, SubmitResult } from "../mempool/mempool.ts";
import { NodeRpcGroup } from "./node-rpc-group.ts";

/**
 * Handlers live layer. Depends on:
 *   - ChainEventStream (live + historical chain events, backed by EventLog)
 *   - Mempool (submit + snapshot)
 *
 * ChainDB + PeerManager dependencies are Phase-3-integrated; until they
 * ship, `GetChainTip`, `GetPeers`, `GetSyncStatus` return placeholders.
 */
export const NodeRpcHandlersLive = NodeRpcGroup.toLayer(
  Effect.gen(function* () {
    const mempool = yield* Mempool;
    const chainEventStream = yield* ChainEventStream;

    return NodeRpcGroup.of({
      GetChainTip: () =>
        // Placeholder — ChainDB.getTip integration lands with Phase 3c
        // proper ChainDB consumer wiring.
        Effect.succeed(Option.none()),

      GetPeers: () =>
        // Placeholder — PeerManager integration needs a cross-service
        // binding; returned empty until Phase 2e Peer Cluster Entity.
        Effect.succeed([]),

      GetMempool: () =>
        mempool.snapshot.pipe(
          Effect.map((entries) =>
            entries.map((e) => ({
              txIdHex: Buffer.from(e.txId).toString("hex"),
              sizeBytes: e.sizeBytes,
              feePerByte: e.feePerByte,
            })),
          ),
        ),

      GetSyncStatus: () =>
        // Placeholder — synced=true + zero behind; real sync-status
        // integration lands with Phase 3f BlockSyncWorkflow + ChainDB
        // wiring.
        Effect.succeed({
          synced: true,
          slotsBehind: 0n,
          tipSlot: 0n,
          blocksProcessed: 0,
        }),

      SubmitTx: ({ txCbor }) =>
        // Stub: extract txId as blake2b-256 of the CBOR. Full tx-id
        // computation matches the ledger's `hashTxBody` function;
        // proper wiring lands with Phase 3e Mempool + ledger TxBody
        // decoder integration.
        Effect.gen(function* () {
          const txId = new Uint8Array(
            new Bun.CryptoHasher("blake2b256").update(txCbor).digest().buffer,
          );
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
