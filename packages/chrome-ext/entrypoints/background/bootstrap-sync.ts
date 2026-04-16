/**
 * Bootstrap sync pipeline — connects to Gerolamino bootstrap server.
 *
 * Two phases on one WebSocket connection:
 * 1. Bootstrap: receive Mithril snapshot data (Init → LedgerState → BlobEntries → Blocks → Complete)
 * 2. Relay: Ouroboros miniprotocol sync via server's TCP proxy (same socket, proxied after Complete)
 *
 * Architecture:
 *   Browser → WebSocket → Bootstrap Server → { Phase 1: TLV stream, Phase 2: TCP proxy }
 *
 * The bootstrap server (apps/bootstrap) streams snapshot data, then transparently
 * bridges the WebSocket to an upstream Cardano relay for miniprotocol traffic.
 */
import { Config, Effect, Fiber, HashMap, Layer, Queue, Ref, Schedule, Stream } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import {
  ConsensusEngineLive,
  ConsensusEvents,
  SlotClock,
  SlotClockLive,
  PREPROD_CONFIG,
  PeerManager,
  PeerManagerLive,
  connectToRelay,
  PREPROD_MAGIC,
  getNodeStatus,
  initialVolatileState,
  Nonces,
  concat,
} from "consensus";
import type { LedgerView } from "consensus";
import { BootstrapMessage, decodeStream } from "bootstrap";
import {
  BlobStore,
  PREFIX_UTXO,
  blockKey,
  blockIndexKey,
  cborOffsetKey,
  runMigrations,
} from "storage";
import { SyncStateRef } from "./sync-state.ts";
import { CryptoServiceBrowser, initWasm } from "./crypto-browser.ts";
import { BrowserStorageLayers } from "./storage-browser.ts";
import { analyzeBlockCbor } from "./block-walker.ts";
import { decodeLedgerStateOffscreen } from "./offscreen-client.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Bootstrap server URL — configurable via BOOTSTRAP_URL env var. */
const ServerBaseUrl = Config.string("BOOTSTRAP_URL").pipe(
  Config.withDefault("ws://178.156.252.81:3040"),
);

/**
 * Enable bootstrap phase (Mithril snapshot download).
 * Disabled by default — bootstrapping requires a frozen Mithril snapshot on
 * the server; using a live relay node's LMDB causes TOCTOU issues (count scan
 * and data scan return different results).
 */
const EnableBootstrap = Config.boolean("ENABLE_BOOTSTRAP").pipe(Config.withDefault(false));

// ---------------------------------------------------------------------------
// Two-phase pipeline: Bootstrap → Relay
// ---------------------------------------------------------------------------

type SnapshotState = {
  tip: { slot: bigint; blockNo: bigint; hash: Uint8Array } | undefined;
  nonces: Nonces;
  ocertCounters: HashMap.HashMap<string, number>;
};

/**
 * Full sync pipeline — bootstrap from server, then relay sync over proxy.
 *
 * Both phases use the same WebSocket connection. The bootstrap server
 * transitions to TCP proxy mode after streaming all snapshot data.
 */
export const bootstrapSyncPipeline = Effect.gen(function* () {
  yield* Effect.log("[bootstrap] Initializing WASM...");
  yield* initWasm;

  // In-memory SQLite starts empty — create tables before using ChainDB
  yield* Effect.log("[bootstrap] Running schema migrations...");
  yield* runMigrations;

  const serverBase = yield* ServerBaseUrl;
  const enableBootstrap = yield* EnableBootstrap;
  const wsUrl = enableBootstrap ? `${serverBase}/bootstrap` : `${serverBase}/relay`;
  yield* Effect.log(
    enableBootstrap
      ? `[bootstrap] Bootstrap enabled — connecting to ${wsUrl}`
      : `[relay] Bootstrap disabled — connecting to relay-only endpoint ${wsUrl}`,
  );

  // Indefinite-connection wrapper: if the WebSocket drops mid-stream or the
  // server closes on pong-miss, retry with exponential backoff. Each retry
  // gets a fresh Effect scope so forked socket-receiver / decode fibers
  // are properly terminated before reconnect. Server keep-alive is handled
  // at the RFC 6455 layer (Bun sendPings + idleTimeout 60s in Change 1 of
  // the plan) — no application-level heartbeat needed.
  yield* Effect.gen(function* () {
    yield* Effect.log(`[sync] Opening WebSocket to ${wsUrl}...`);
    const socket = yield* Socket.makeWebSocket(wsUrl);
    yield* Effect.log("[sync] WebSocket connected");
    yield* Effect.addFinalizer(() =>
      Effect.log("[sync] WebSocket scope closing — releasing socket + fibers"),
    );
    // Bounded queue provides backpressure: when the consumer (IDB writes)
    // can't keep up with the producer (socket), the producer fiber suspends
    // on offer() instead of buffering unboundedly. 256 slots ≈ 44MB peak at
    // 175KB/frame (batched UTxOs). The WS layer handles Pong responses
    // independently so the connection stays alive while blocked.
    const byteQueue = yield* Queue.bounded<Uint8Array>(256);

    // Fork socket receiver: pushes received bytes into the shared queue.
    yield* Effect.forkScoped(
      socket
        .run((data: Uint8Array) => Queue.offer(byteQueue, data))
        .pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Effect.log("[sync] Socket receiver exited — shutting down byte queue");
              yield* Queue.shutdown(byteQueue);
            }),
          ),
        ),
    );

    const store = yield* BlobStore;
    const syncState = yield* SyncStateRef;

    // --- Phase 1: Bootstrap (optional) ---
    // When enabled, the server streams Mithril snapshot data (Init → LedgerState
    // → BlobEntries → Blocks → Complete), then switches to TCP proxy mode.
    // When disabled, the server proxies to upstream relay immediately.
    let ledgerView: LedgerView | undefined;
    let snapshotState: SnapshotState | undefined;

    if (enableBootstrap) {
      yield* syncState.update({ status: "bootstrapping", bootstrapPhase: "awaiting-init" });

      const blobCountRef = yield* Ref.make(0);
      const blockCountRef = yield* Ref.make(0);
      const snapshotStateRef = yield* Ref.make<SnapshotState | undefined>(undefined);
      const ledgerViewRef = yield* Ref.make<LedgerView | undefined>(undefined);
      const pendingBlockEntries: Array<{ readonly key: Uint8Array; readonly value: Uint8Array }> = [];
      const BLOCK_BATCH = 50;
      const ledgerDecodeFiberRef = yield* Ref.make<
        Fiber.Fiber<void, unknown> | undefined
      >(undefined);

      yield* decodeStream(Stream.fromQueue(byteQueue)).pipe(
        Stream.takeUntil(BootstrapMessage.guards.Complete),
        Stream.runForEach(
          BootstrapMessage.match({
            Init: (m) =>
              Effect.gen(function* () {
                yield* Effect.log(
                  `[bootstrap] Snapshot: slot ${m.snapshotSlot}, magic ${m.protocolMagic}, ` +
                    `${m.totalChunks} chunks, ${m.totalBlobEntries} entries`,
                );
                const parsed = new URL(wsUrl);
                yield* syncState.update({
                  protocolMagic: m.protocolMagic,
                  snapshotSlot: m.snapshotSlot.toString(),
                  totalChunks: m.totalChunks,
                  totalBlobEntries: m.totalBlobEntries,
                  bootstrapPhase: "awaiting-ledger-state",
                  network: m.protocolMagic === 1 ? "preprod"
                    : m.protocolMagic === 764824073 ? "mainnet"
                    : "preview",
                  relayHost: parsed.hostname,
                  relayPort: parseInt(parsed.port, 10) || 3040,
                });
              }),
            LedgerState: (m) =>
              Effect.gen(function* () {
                yield* Effect.log(
                  `[bootstrap] Ledger state: ${m.payload.length} bytes — dispatching to offscreen worker`,
                );
                yield* syncState.update({
                  ledgerStateReceived: true,
                  bootstrapPhase: "decoding-ledger-state",
                });
                const fiber = yield* Effect.forkScoped(
                  Effect.gen(function* () {
                    const decoded = yield* decodeLedgerStateOffscreen(m.payload);
                    yield* Ref.set(ledgerViewRef, decoded.ledgerView);
                    yield* Ref.set(snapshotStateRef, {
                      tip: decoded.tip,
                      nonces: decoded.nonces,
                      ocertCounters: decoded.ledgerView.ocertCounters,
                    });
                    yield* Effect.log(
                      `[bootstrap] Offscreen decode complete — tip ${decoded.tip?.slot ?? "origin"}, ` +
                        `${decoded.accountsWritten} accounts, ${decoded.stakeEntriesWritten} stake`,
                    );
                    yield* syncState.update({
                      ledgerStateDecoded: true,
                      accountsWritten: decoded.accountsWritten,
                      stakeEntriesWritten: decoded.stakeEntriesWritten,
                      totalAccounts: decoded.accountsWritten,
                      totalStakeEntries: decoded.stakeEntriesWritten,
                    });
                  }).pipe(
                    Effect.tapError((e) =>
                      Effect.logError(`[bootstrap] Offscreen decode failed: ${e}`),
                    ),
                  ),
                );
                yield* Ref.set(ledgerDecodeFiberRef, fiber);
              }),
            LedgerMeta: (m) => Effect.log(`[bootstrap] Ledger meta: ${m.payload.length} bytes`),
            BlobEntries: (m) =>
              Effect.gen(function* () {
                yield* store.putBatch(
                  m.entries.map((e) => ({
                    key: concat(PREFIX_UTXO, e.key),
                    value: e.value,
                  })),
                );
                const newBlobCount = yield* Ref.updateAndGet(blobCountRef, (n) => n + m.count);
                if (newBlobCount % 500 === 0) {
                  yield* syncState.update({
                    blobEntriesReceived: newBlobCount,
                    bootstrapPhase: "receiving-utxos",
                  });
                }
                if (newBlobCount % 5000 === 0) {
                  yield* Effect.log(`[bootstrap] UTxO entries: ${newBlobCount}`);
                }
              }),
            Block: (m) =>
              Effect.gen(function* () {
                const { blockNo, txOffsets } = analyzeBlockCbor(m.blockCbor);
                pendingBlockEntries.push(
                  { key: blockKey(m.slotNo, m.headerHash), value: m.blockCbor },
                );
                if (blockNo > 0n) {
                  const idxVal = new Uint8Array(40);
                  new DataView(idxVal.buffer).setBigUint64(0, m.slotNo, false);
                  idxVal.set(m.headerHash, 8);
                  pendingBlockEntries.push({ key: blockIndexKey(blockNo), value: idxVal });
                }
                for (let i = 0; i < txOffsets.length; i++) {
                  const o = txOffsets[i]!;
                  const val = new Uint8Array(8);
                  const dv = new DataView(val.buffer);
                  dv.setUint32(0, o.offset, false);
                  dv.setUint32(4, o.size, false);
                  pendingBlockEntries.push({ key: cborOffsetKey(m.slotNo, i), value: val });
                }
                const newBlockCount = yield* Ref.updateAndGet(blockCountRef, (n) => n + 1);
                if (newBlockCount % BLOCK_BATCH === 0) {
                  yield* store.putBatch(pendingBlockEntries.splice(0));
                }
                if (newBlockCount % 100 === 0) {
                  yield* syncState.update({
                    blocksReceived: newBlockCount,
                    bootstrapPhase: "receiving-blocks",
                  });
                }
                if (newBlockCount % 1000 === 0) {
                  yield* Effect.log(`[bootstrap] Blocks: ${newBlockCount}`);
                }
              }),
            Progress: (m) => Effect.log(`[bootstrap] Progress: ${m.phase} ${m.current}/${m.total}`),
            Complete: () =>
              Effect.gen(function* () {
                if (pendingBlockEntries.length > 0) {
                  yield* store.putBatch(pendingBlockEntries.splice(0));
                }
                const finalBlobCount = yield* Ref.get(blobCountRef);
                const finalBlockCount = yield* Ref.get(blockCountRef);
                yield* Effect.log(
                  `[bootstrap] Complete: ${finalBlobCount} UTxO entries, ${finalBlockCount} blocks`,
                );
                yield* syncState.update({
                  blobEntriesReceived: finalBlobCount,
                  blocksReceived: finalBlockCount,
                  bootstrapComplete: true,
                });
              }),
          }),
        ),
      );

      const decodeFiber = yield* Ref.get(ledgerDecodeFiberRef);
      if (decodeFiber) {
        yield* Effect.log("[bootstrap] Awaiting offscreen decode fiber...");
        yield* Fiber.join(decodeFiber);
      } else {
        yield* Effect.logWarning("[bootstrap] No LedgerState arrived — decode fiber never forked");
      }

      ledgerView = yield* Ref.get(ledgerViewRef);
      snapshotState = yield* Ref.get(snapshotStateRef);
      if (!ledgerView) {
        yield* syncState.update({
          status: "error",
          lastError: "Bootstrap completed without LedgerState",
        });
        return yield* Effect.die("Bootstrap completed without receiving LedgerState");
      }

      yield* Effect.log(
        "[bootstrap] All tables populated. Switching to relay sync...",
      );
    }

    // Empty ledger view for relay-only mode — pool-dependent assertions
    // (VRF key, VRF proof, leader stake) gracefully skip when pool data is
    // absent. Pool-independent assertions (KES, opcert) still run.
    if (!ledgerView) {
      ledgerView = {
        epochNonce: new Uint8Array(32),
        poolVrfKeys: HashMap.empty(),
        poolStake: HashMap.empty(),
        totalStake: 0n,
        activeSlotsCoeff: 0.05,
        maxKesEvolutions: 62,
        maxHeaderSize: 0,
        maxBlockBodySize: 0,
        ocertCounters: HashMap.empty(),
      };
    }

    // Set network info — in bootstrap mode this was set by the Init handler;
    // in relay-only mode we derive it from the known config + URL.
    if (!enableBootstrap) {
      const parsed = new URL(wsUrl);
      yield* syncState.update({
        protocolMagic: PREPROD_MAGIC,
        network: "preprod",
        relayHost: parsed.hostname,
        relayPort: parseInt(parsed.port, 10) || 3040,
      });
    }

    yield* syncState.update({ status: "syncing", bootstrapPhase: "complete" });

  // --- Phase 2: Relay sync ---
  // Stream.takeUntil(Complete) stops pulling from byteQueue — any bytes
  // received after Complete remain in the queue for the relay phase.
  // The same WebSocket is now proxied to the upstream Cardano relay.
  // Create a Socket.Socket that reads from the shared byte queue.
  const relaySocket: Socket.Socket = {
    [Socket.TypeId]: Socket.TypeId,
    run: (handler, _options?) =>
      Stream.fromQueue(byteQueue).pipe(
        Stream.runForEach((data) => {
          const result = handler(data);
          return result ?? Effect.void;
        }),
      ),
    runRaw: (handler, _options?) =>
      Stream.fromQueue(byteQueue).pipe(
        Stream.runForEach((data) => {
          const result = handler(data);
          return result ?? Effect.void;
        }),
      ),
    writer: socket.writer,
  };

  // Shared volatile state ref — written by relay sync loop, read by monitor.
  const volatileRef = yield* Ref.make(
    initialVolatileState(
      snapshotState?.tip,
      snapshotState?.nonces ?? new Nonces({
        active: new Uint8Array(32),
        evolving: new Uint8Array(32),
        candidate: new Uint8Array(32),
        epoch: 0n,
      }),
      snapshotState?.ocertCounters ?? HashMap.empty(),
    ),
  );

  const peerId = "bootstrap-proxy:3001";

  // Push initial peer entry so the dashboard shows the peer immediately
  // (the 10s monitor loop will update with real tip/status data).
  yield* syncState.update({
    peers: [{ id: peerId, status: "connected", tipSlot: "0" }],
  });

  // Relay sync + monitor loop in parallel (with relay-only retry)
  yield* Effect.log(`[relay] Starting Ouroboros miniprotocol sync over proxy (peerId=${peerId})`);
  yield* Effect.retry(
    Effect.all(
      [
        connectToRelay(peerId, PREPROD_MAGIC, ledgerView, snapshotState, volatileRef).pipe(
          Effect.provideService(Socket.Socket, relaySocket),
          Effect.tapError((e) =>
            Effect.gen(function* () {
              yield* Effect.logWarning(`[relay] Error: ${e} — will retry`);
              yield* syncState.update({ status: "error", lastError: String(e) });
            }),
          ),
        ),
        // Monitor loop: push relay progress to SyncStateRef every 10s.
        // A counter Ref throttles tip/progress logs to once per minute while
        // still updating SyncStateRef (and thus the popup UI) every 10s.
        Effect.gen(function* () {
          const tickRef = yield* Ref.make(0);
          const lastTipRef = yield* Ref.make<string>("");
          yield* Effect.repeat(
            Effect.gen(function* () {
              const nodeStatus = yield* getNodeStatus(volatileRef);
              const peerManager = yield* PeerManager;
              const peers = yield* peerManager.getPeers;
              const tick = yield* Ref.updateAndGet(tickRef, (n) => n + 1);
              const tipStr = nodeStatus.tipSlot.toString();
              const lastTip = yield* Ref.get(lastTipRef);
              if (lastTip === "" && tipStr !== "0") {
                yield* Effect.log(
                  `[relay] First tip observed: slot ${tipStr} (epoch ${nodeStatus.epochNumber}, ${nodeStatus.blocksProcessed} blocks processed)`,
                );
                yield* Ref.set(lastTipRef, tipStr);
              } else if (tick % 6 === 0) {
                // Every 60s (10s × 6): periodic sync snapshot
                yield* Effect.log(
                  `[relay] tip=${tipStr} epoch=${nodeStatus.epochNumber} sync=${nodeStatus.syncPercent}% gsm=${nodeStatus.gsmState} peers=${nodeStatus.peerCount}`,
                );
              }
              yield* syncState.update({
                status: nodeStatus.syncPercent >= 100 ? "caught-up" : "syncing",
                tipSlot: tipStr,
                blocksProcessed: nodeStatus.blocksProcessed,
                syncPercent: nodeStatus.syncPercent,
                currentSlot: nodeStatus.currentSlot.toString(),
                epochNumber: nodeStatus.epochNumber.toString(),
                peerCount: nodeStatus.peerCount,
                gsmState: nodeStatus.gsmState,
                peers: peers.map((p) => ({
                  id: p.peerId,
                  status: p.status,
                  tipSlot: (p.tip?.slot ?? 0n).toString(),
                })),
              });
            }).pipe(
              Effect.catch((e) => Effect.logWarning(`[monitor] Check failed: ${e}`)),
            ),
            Schedule.fixed("10 seconds"),
          );
        }),
      ],
      { concurrency: "unbounded" },
    ),
    Schedule.exponential("5 seconds", 2).pipe(Schedule.take(5)),
  );
  }).pipe(
    Effect.scoped,
    Effect.tapError((err) =>
      Effect.logWarning(`[bootstrap] Connection failed (${String(err)}) — will reconnect`),
    ),
    Effect.retry(
      Schedule.exponential("1 second", 2).pipe(
        Schedule.either(Schedule.spaced("30 seconds")),
      ),
    ),
  );
}).pipe(Effect.provide(browserLayers()));

// ---------------------------------------------------------------------------
// Browser service layers
// ---------------------------------------------------------------------------

/**
 * Browser service layers for sync pipeline.
 *
 * Provides:
 * - WebSocket constructor (browser global)
 * - ConsensusEngine + CryptoService (WASM-based)
 * - ConsensusEvents (PubSub for tip changes, epoch transitions)
 * - ChainDB (IndexedDB BlobStore + SQLite WASM)
 * - SlotClock (preprod config)
 * - PeerManager
 * - IndexedDb (browser window)
 */
function browserLayers() {
  const wsConstructorLayer = Socket.layerWebSocketConstructorGlobal;

  const consensusLayer = ConsensusEngineLive.pipe(Layer.provideMerge(CryptoServiceBrowser));

  const slotClockLayer = Layer.effect(SlotClock, SlotClockLive(PREPROD_CONFIG));

  const peerManagerLayer = Layer.effect(PeerManager, PeerManagerLive).pipe(
    Layer.provide(slotClockLayer),
  );

  // Service workers have no `window` — use globalThis.indexedDB directly.
  // IndexedDb.layerWindow fails in MV3 service workers because it accesses `window`.
  const indexedDbLayer = Layer.succeed(
    IndexedDb.IndexedDb,
    IndexedDb.make({
      indexedDB: globalThis.indexedDB,
      IDBKeyRange: globalThis.IDBKeyRange,
    }),
  );
  const storageLayer = BrowserStorageLayers().pipe(Layer.provide(indexedDbLayer), Layer.orDie);

  return Layer.mergeAll(
    wsConstructorLayer,
    consensusLayer,
    CryptoServiceBrowser,
    ConsensusEvents.Live,
    slotClockLayer,
    peerManagerLayer,
    storageLayer,
  );
}

// ---------------------------------------------------------------------------
// With state updates (entry point for background worker)
// ---------------------------------------------------------------------------

/**
 * Run bootstrap sync with state updates pushed via SyncStateRef.
 * SyncStateRef pushes to both RPC streaming subscribers and chrome.storage.session.
 */
export const bootstrapSyncWithStateUpdates = Effect.gen(function* () {
  const syncState = yield* SyncStateRef;
  yield* syncState.update({ status: "connecting" });

  yield* bootstrapSyncPipeline.pipe(
    Effect.tapError((err) => syncState.update({ status: "error", lastError: String(err) })),
  );
});
