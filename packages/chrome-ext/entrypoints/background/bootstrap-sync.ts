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
import { Config, Effect, HashMap, Layer, Queue, Ref, Stream } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import * as IndexedDb from "@effect/platform-browser/IndexedDb";
import {
  ConsensusEngineLive,
  SlotClock,
  SlotClockLive,
  PREPROD_CONFIG,
  PeerManager,
  PeerManagerLive,
  connectToRelay,
  PREPROD_MAGIC,
  extractLedgerView,
  extractNonces,
  extractSnapshotTip,
  concat,
} from "consensus";
import type { LedgerView } from "consensus";
import { decodeExtLedgerState } from "ledger";
import { MessageTag, concatBytes, extractFrames, decodeFrame } from "bootstrap";
import { BlobStore, PREFIX_UTXO, blockKey, runMigrations } from "storage";
import { SyncStateRef } from "./sync-state.ts";
import { CryptoServiceBrowser, initWasm } from "./crypto-browser.ts";
import { BrowserStorageLayers } from "./storage-browser.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Bootstrap server URL — configurable via BOOTSTRAP_URL env var. */
const BootstrapUrl = Config.string("BOOTSTRAP_URL").pipe(
  Config.withDefault("ws://178.156.252.81:3040/bootstrap"),
);

// ---------------------------------------------------------------------------
// Two-phase pipeline: Bootstrap → Relay
// ---------------------------------------------------------------------------

type SnapshotState = {
  tip: { slot: bigint; hash: Uint8Array } | undefined;
  nonces: ReturnType<typeof extractNonces>;
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

  const bootstrapUrl = yield* BootstrapUrl;
  yield* Effect.log(`[bootstrap] Connecting to ${bootstrapUrl}`);

  // Open WebSocket — shared by both bootstrap and relay phases.
  // After Complete, the server switches to TCP proxy mode on the same socket.
  const socket = yield* Socket.makeWebSocket(bootstrapUrl);
  const byteQueue = yield* Queue.unbounded<Uint8Array>();

  // Fork socket receiver: pushes ALL received bytes into the shared queue.
  // Bootstrap reads TLV frames from this queue; relay reads muxer frames.
  yield* Effect.forkScoped(
    socket
      .run((data: Uint8Array) => Queue.offer(byteQueue, data))
      .pipe(Effect.ensuring(Queue.shutdown(byteQueue))),
  );

  // --- Phase 1: Bootstrap ---
  const store = yield* BlobStore;
  const syncState = yield* SyncStateRef;
  yield* syncState.update({ status: "bootstrapping" });

  const blobCountRef = yield* Ref.make(0);
  const blockCountRef = yield* Ref.make(0);
  const ledgerViewRef = yield* Ref.make<LedgerView | undefined>(undefined);
  const snapshotStateRef = yield* Ref.make<SnapshotState | undefined>(undefined);

  // Read TLV frames from byte queue until Complete message.
  // Uses while loop — `return` from Complete exits cleanly (no Effect.interrupt
  // which would kill the entire fiber and prevent relay phase from starting).
  const bufferRef = yield* Ref.make(new Uint8Array(0));

  yield* Effect.gen(function* () {
    let bootstrapDone = false;
    while (!bootstrapDone) {
      const chunk = yield* Queue.take(byteQueue);
      const buffer = yield* Ref.get(bufferRef);
      const combined = concatBytes(buffer, chunk);
      const { frames, remaining } = extractFrames(combined);
      yield* Ref.set(bufferRef, new Uint8Array(remaining));

      for (const frame of frames) {
        const msg = decodeFrame(new Uint8Array(frame));

        switch (msg.tag) {
          case MessageTag.Init:
            yield* Effect.log(
              `[bootstrap] Snapshot: slot ${msg.snapshotSlot}, magic ${msg.protocolMagic}, ` +
                `${msg.totalChunks} chunks, ${msg.totalBlobEntries} entries`,
            );
            yield* syncState.update({
              protocolMagic: msg.protocolMagic,
              snapshotSlot: msg.snapshotSlot.toString(),
              totalChunks: msg.totalChunks,
              totalBlobEntries: msg.totalBlobEntries,
            });
            break;

          case MessageTag.LedgerState: {
            yield* Effect.log(`[bootstrap] Ledger state: ${msg.payload.length} bytes, decoding...`);
            const extState = yield* decodeExtLedgerState(msg.payload);
            yield* Effect.log(
              `[bootstrap] Decoded: era ${extState.currentEra}, epoch ${extState.newEpochState.epoch}, ` +
                `${extState.newEpochState.poolDistr.pools.size} pools`,
            );
            const lv = yield* extractLedgerView(extState);
            const nonces = extractNonces(extState);
            const tip = extractSnapshotTip(extState);
            yield* Ref.set(ledgerViewRef, lv);
            yield* Ref.set(snapshotStateRef, { tip, nonces });
            yield* Effect.log(
              `[bootstrap] Tip slot ${tip?.slot ?? "origin"}, totalStake ${lv.totalStake}, ` +
                `${HashMap.size(lv.poolVrfKeys)} VRF keys`,
            );
            yield* syncState.update({ ledgerStateReceived: true });
            break;
          }

          case MessageTag.LedgerMeta:
            yield* Effect.log(`[bootstrap] Ledger meta: ${msg.payload.length} bytes`);
            break;

          case MessageTag.BlobEntries: {
            yield* store.putBatch(
              msg.entries.map((e) => ({
                key: concat(PREFIX_UTXO, e.key),
                value: e.value,
              })),
            );
            const newBlobCount = yield* Ref.updateAndGet(blobCountRef, (n) => n + msg.count);
            if (newBlobCount % 5000 === 0) {
              yield* Effect.log(`[bootstrap] UTxO entries: ${newBlobCount}`);
              yield* syncState.update({ blobEntriesReceived: newBlobCount });
            }
            break;
          }

          case MessageTag.Block: {
            yield* store.put(
              blockKey(msg.slotNo, msg.headerHash),
              msg.blockCbor,
            );
            const newBlockCount = yield* Ref.updateAndGet(blockCountRef, (n) => n + 1);
            if (newBlockCount % 1000 === 0) {
              yield* Effect.log(`[bootstrap] Blocks: ${newBlockCount}`);
              yield* syncState.update({ blocksReceived: newBlockCount });
            }
            break;
          }

          case MessageTag.Progress:
            yield* Effect.log(`[bootstrap] Progress: ${msg.phase} ${msg.current}/${msg.total}`);
            break;

          case MessageTag.Complete: {
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
            bootstrapDone = true;
            break;
          }
        }
        if (bootstrapDone) break;
      }
    }
  });

  const ledgerView = yield* Ref.get(ledgerViewRef);
  const snapshotState = yield* Ref.get(snapshotStateRef);
  if (!ledgerView) {
    yield* syncState.update({ status: "error", lastError: "Bootstrap completed without LedgerState" });
    return yield* Effect.die("Bootstrap completed without receiving LedgerState");
  }

  yield* Effect.log("[bootstrap] Switching to relay sync via proxy...");
  yield* syncState.update({ status: "syncing" });

  // --- Phase 2: Relay sync ---
  // Inject any leftover bytes from TLV frame parsing into the relay queue.
  // Without this, the Multiplexer misses the first bytes of the handshake
  // response if they arrived in the same TCP segment as the Complete frame.
  const leftover = yield* Ref.get(bufferRef);
  if (leftover.length > 0) {
    yield* Effect.log(`[bootstrap] Injecting ${leftover.length} leftover bytes into relay queue`);
    yield* Queue.offer(byteQueue, leftover);
  }

  // The same WebSocket is now proxied to the upstream Cardano relay.
  // Create a Socket.Socket that reads from the shared byte queue.
  const relaySocket: Socket.Socket = {
    [Socket.TypeId]: Socket.TypeId,
    run: (handler) =>
      Stream.fromQueue(byteQueue).pipe(
        Stream.runForEach((data) => {
          const result = handler(data);
          return result ?? Effect.void;
        }),
      ),
    runRaw: (handler) =>
      Stream.fromQueue(byteQueue).pipe(
        Stream.runForEach((data) => {
          const result = handler(data);
          return result ?? Effect.void;
        }),
      ),
    writer: socket.writer,
  };

  const peerId = "bootstrap-proxy:3001";
  yield* connectToRelay(peerId, PREPROD_MAGIC, ledgerView, snapshotState).pipe(
    Effect.provideService(Socket.Socket, relaySocket),
    Effect.tapError((e) =>
      Effect.gen(function* () {
        yield* Effect.logWarning(`[relay] Error: ${e}`);
        yield* syncState.update({ status: "error", lastError: String(e) });
      }),
    ),
  );
}).pipe(
  Effect.scoped,
  Effect.provide(browserLayers()),
);

// ---------------------------------------------------------------------------
// Browser service layers
// ---------------------------------------------------------------------------

/**
 * Browser service layers for sync pipeline.
 *
 * Provides:
 * - WebSocket constructor (browser global)
 * - ConsensusEngine + CryptoService (WASM-based)
 * - ChainDB (IndexedDB BlobStore + SQLite WASM OPFS)
 * - SlotClock (preprod config)
 * - PeerManager
 * - IndexedDb (browser window)
 */
function browserLayers() {
  const wsConstructorLayer = Socket.layerWebSocketConstructorGlobal;

  const consensusLayer = ConsensusEngineLive.pipe(
    Layer.provideMerge(CryptoServiceBrowser),
  );

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
  const storageLayer = BrowserStorageLayers().pipe(
    Layer.provide(indexedDbLayer),
    Layer.orDie,
  );

  return Layer.mergeAll(
    wsConstructorLayer,
    consensusLayer,
    CryptoServiceBrowser,
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
    Effect.tapError((err) =>
      syncState.update({ status: "error", lastError: String(err) }),
    ),
  );
});
