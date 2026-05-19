/**
 * Offscreen-side sync pipeline.
 *
 * Runs in the offscreen document (Chrome MV3 WORKERS reason) as an
 * indefinite daemon. The previous incarnation had two ingestion modes:
 *
 *   - **remote**: pull a Mithril snapshot over WebSocket from the
 *     `apps/bootstrap` server, then transition to relay sync.
 *   - **local**: drag-drop a snapshot directory in the popup, walk it
 *     via the File System Access API, stream the bytes into the
 *     lsm-worker's OPFS, then transition to relay sync.
 *
 * `apps/bootstrap` has been deleted (May 2026) — the only ingestion
 * mode now is drag-drop. When the popup uploads a snapshot, the
 * lsm-worker writes it into OPFS at `/data/lsm/…`; this pipeline
 * picks the session up from there. When no snapshot is uploaded, the
 * pipeline starts the relay sync from genesis with an empty
 * `LedgerView`.
 *
 * Relay sync still flows through `${serverBase}/relay` — a WS→TCP
 * proxy is required because browsers can't open raw TCP sockets.
 * The proxy is out-of-tree (no longer bundled with this monorepo);
 * the URL is build-time configurable via `BOOTSTRAP_URL` env var.
 */
import { Effect, HashMap, Layer, Metric, Ref, Schedule } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import {
  ChainEventsLive,
  ConsensusEvents,
  PeerManager,
  PeerManagerLayer,
  SlotClockPreprod,
  connectToRelay,
  PREPROD_MAGIC,
  getNodeStatus,
  initialVolatileState,
  Nonces,
} from "consensus";
import type { LedgerView } from "consensus";
// `initWasm` keeps the subpath form because tsgo's cross-package
// barrel re-export drop affects `export * from "./X.ts"` chains.
import { initWasm } from "wasm-utils/init.ts";
// `wasm-plexer` MUST use the bare specifier — `wxt.config.ts`
// aliases `^wasm-plexer$` to `packages/wasm-plexer/browser.js` to
// substitute the Bun-only `Bun.file(...)` loader in `wasm-init.ts`
// with the browser fetch-based one. Subpath imports like
// `wasm-plexer/index.ts` bypass the alias and pull `wasm-init.ts`
// into the browser bundle, where it throws `Bun is not defined` at
// module load.
//
// tsgo's cross-package re-export drop hides `init` from the bare
// specifier's perspective even though it IS exported by both
// `src/index.ts` (the standalone shape) and `browser.js` (the wxt
// runtime swap). `@ts-ignore` here is precise: the import is
// correct at runtime in both Bun (apps/tui) and browser (chrome-ext)
// contexts; only tsgo's resolver can't see it.
// @ts-ignore — wasm-plexer alias-swapped to browser.js at runtime; tsgo can't follow the wxt alias.
import { init as initWasmPlexer } from "wasm-plexer";
import { CryptoWorkerBrowser } from "./crypto-pool.ts";
import {
  pushNodeState,
  pushBootstrapProgress,
  pushNetworkInfo,
  pushPeers,
} from "./atoms.ts";
import { ChainDBLive, LedgerSnapshotStoreLive } from "storage";
import { loadSettings } from "../shared/bootstrap-settings.ts";
import { readLedgerStateFromOpfs } from "./snapshot-ingest.ts";
import * as Metrics from "./metrics.ts";

declare const __BOOTSTRAP_URL__: string;

export const bootstrapSyncPipeline = Effect.gen(function* () {
  yield* Effect.log("[offscreen-sync] Initializing WASM...");
  yield* Effect.timed(
    Effect.all([initWasm, Effect.promise(() => initWasmPlexer())], { concurrency: 2 }),
  ).pipe(
    Effect.tap(([duration, _]) => Metric.update(Metrics.wasmInitLatencyMs, duration)),
    Effect.tap(() => Metric.update(Metrics.wasmInitSuccess, 1)),
    Effect.tapError(() => Metric.update(Metrics.wasmInitFailure, 1)),
  );

  const persisted = yield* loadSettings;
  const settings = persisted ?? {
    mode: "genesis" as const,
    serverUrl: __BOOTSTRAP_URL__,
  };
  yield* Effect.log(
    `[offscreen-sync] Settings: mode=${settings.mode}, relayUrl=${settings.serverUrl} ` +
      `(${persisted ? "from chrome.storage.local" : "build-time defaults"})`,
  );

  if (settings.mode === "local") {
    yield* Effect.log(
      "[offscreen-sync] Local-snapshot mode — relay sync resumes from the " +
        "lsm-tree session that the popup's drag-drop populated in OPFS " +
        "(`/data/lsm/`). If the session is empty, this collapses to a " +
        "genesis-style sync from the upstream relay.",
    );
  }

  const wsUrl = `${settings.serverUrl}/relay`;
  yield* Effect.log(`[offscreen-sync] Connecting to relay proxy ${wsUrl}`);

  // Seed `LedgerView` + `Nonces` from OPFS BEFORE opening the
  // relay WebSocket. If the popup has uploaded a Mithril snapshot,
  // this finds `ledger/<slot>/state`, decodes the CBOR
  // `ExtLedgerState`, and extracts the stake distribution + nonce
  // chain. Returns undefined when OPFS is empty — falls back to a
  // genesis `LedgerView` and origin tip below.
  yield* pushNodeState({ status: "bootstrapping" });
  yield* pushBootstrapProgress({ phase: "awaiting-ledger-state" });
  yield* Metric.update(Metrics.bootstrapPhaseTransitions, "awaiting-ledger-state");
  const ingest = yield* readLedgerStateFromOpfs.pipe(
    Effect.tap((value) =>
      value !== undefined
        ? Metric.update(Metrics.opfsIngestSuccess, 1)
        : Metric.update(Metrics.opfsIngestFallback, 1),
    ),
    Effect.tapError((e) =>
      Effect.logWarning(`[offscreen-sync] OPFS ingest failed: ${e} — using genesis`).pipe(
        Effect.andThen(Metric.update(Metrics.opfsIngestFallback, 1)),
      ),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  );

  yield* Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(wsUrl);
    yield* Metric.update(Metrics.wsConnect, 1);
    yield* Effect.log("[offscreen-sync] WebSocket connected");
    yield* Effect.addFinalizer(() =>
      Effect.log("[offscreen-sync] WebSocket scope closing — releasing socket + fibers").pipe(
        Effect.andThen(Metric.update(Metrics.wsDisconnect, 1)),
      ),
    );

    // Genesis-mode LedgerView. Consensus's gentle-skip behavior
    // (size === 0 → bypass) treats this as a valid placeholder
    // until enough blocks have been synced. Only used when OPFS
    // ingest above returned undefined.
    const GENESIS_LEDGER_VIEW: LedgerView = {
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
    const ledgerView: LedgerView = ingest?.ledgerView ?? GENESIS_LEDGER_VIEW;
    const snapshotState = ingest?.snapshotState;

    const parsed = new URL(wsUrl);
    yield* pushNetworkInfo({
      network: "preprod",
      protocolMagic: PREPROD_MAGIC,
      relayHost: parsed.hostname,
      relayPort: parseInt(parsed.port, 10) || 3040,
    });

    yield* pushNodeState({ status: "syncing" });
    yield* pushBootstrapProgress({
      phase: "complete",
      ledgerStateDecoded: ingest !== undefined,
    });
    yield* Metric.update(Metrics.bootstrapPhaseTransitions, "complete");

    const volatileRef = yield* Ref.make(
      initialVolatileState(
        snapshotState?.tip,
        snapshotState?.nonces ??
          new Nonces({
            active: new Uint8Array(32),
            evolving: new Uint8Array(32),
            candidate: new Uint8Array(32),
            epoch: 0n,
          }),
        ledgerView.ocertCounters,
      ),
    );

    const peerId = "relay-proxy:3001";
    yield* pushPeers([{ id: peerId, address: peerId, status: "connecting", tipSlot: 0n }]);

    yield* Effect.log(
      `[offscreen-sync] Starting Ouroboros miniprotocol sync over proxy (peerId=${peerId}; ` +
        `seeded=${ingest !== undefined ? "snapshot" : "genesis"})`,
    );
    yield* Effect.retry(
      Effect.all(
        [
          connectToRelay(peerId, PREPROD_MAGIC, ledgerView, snapshotState, volatileRef).pipe(
            Effect.provideService(Socket.Socket, socket),
            Effect.tapError((e) =>
              Effect.logWarning(`[offscreen-sync] Error: ${e} — will retry`).pipe(
                Effect.andThen(pushNodeState({ status: "error", lastError: String(e) })),
              ),
            ),
          ),
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
                    `[offscreen-sync] First tip observed: slot ${tipStr} (epoch ${nodeStatus.epochNumber}, ${nodeStatus.blocksProcessed} blocks processed)`,
                  );
                  yield* Ref.set(lastTipRef, tipStr);
                } else if (tick % 6 === 0) {
                  yield* Effect.log(
                    `[offscreen-sync] tip=${tipStr} epoch=${nodeStatus.epochNumber} sync=${nodeStatus.syncPercent}% gsm=${nodeStatus.gsmState} peers=${nodeStatus.peerCount}`,
                  );
                }
                yield* pushNodeState({
                  status: nodeStatus.syncPercent >= 100 ? "caught-up" : "syncing",
                  tipSlot: nodeStatus.tipSlot,
                  currentSlot: nodeStatus.currentSlot,
                  epochNumber: nodeStatus.epochNumber,
                  blocksProcessed: nodeStatus.blocksProcessed,
                  syncPercent: nodeStatus.syncPercent,
                  gsmState: nodeStatus.gsmState,
                });
                yield* Metric.update(Metrics.tipSlot, nodeStatus.tipSlot);
                yield* Metric.update(Metrics.syncPercent, nodeStatus.syncPercent);
                yield* Metric.update(Metrics.peerCount, nodeStatus.peerCount);
                yield* Metric.update(Metrics.epochNumber, BigInt(nodeStatus.epochNumber));
                yield* pushPeers(
                  peers.map((p) => ({
                    id: p.peerId,
                    address: p.peerId,
                    status: p.status,
                    tipSlot: p.tip?.slot ?? 0n,
                  })),
                );
              }).pipe(Effect.catch((e) => Effect.logWarning(`[offscreen-monitor] Check failed: ${e}`))),
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
      Effect.logWarning(
        `[offscreen-sync] Connection failed (${String(err)}) — will reconnect`,
      ),
    ),
    Effect.retry(
      Schedule.exponential("1 second", 2).pipe(Schedule.either(Schedule.spaced("30 seconds"))),
    ),
  );
});

/**
 * Layer that provides everything `bootstrapSyncPipeline` requires
 * EXCEPT `BlobStore` (and the derived `ChainDB` /
 * `LedgerSnapshotStore` that compose on top of it).
 *
 * Hoisted out of the pipeline body so `main.ts` can compose a single
 * shared `LsmWorkerBrowser` instance and provide it to BOTH this
 * sync layer AND the `OffscreenRpcServerLive` snapshot-upload
 * handlers. Without the hoist, two separate
 * `Effect.provide(LsmWorkerBrowser)` sites would each spawn their
 * own dedicated Worker — and two workers writing to the same OPFS-
 * backed lsm-tree session would corrupt the tree (lsm-tree is
 * single-writer; the WASM blockio shim's `tryLockFile` grants
 * unconditionally on the assumption that the host runtime enforces
 * exclusivity).
 */
export const browserLayersWithoutBlobStore = Layer.mergeAll(
  Socket.layerWebSocketConstructorGlobal,
  // 4-Worker browser crypto pool. Each parallel header-validation
  // crypto verify (VRF proof, leader threshold, KES, opcert ed25519)
  // routes through `RpcClient.layerProtocolWorker`'s round-robin
  // dispatcher to a dedicated Web Worker.
  CryptoWorkerBrowser.pipe(Layer.orDie),
  ChainEventsLive,
  ConsensusEvents.Live,
  SlotClockPreprod,
  PeerManagerLayer.pipe(Layer.provide(SlotClockPreprod)),
);

/**
 * Layer providing `BlobStore` + the consensus services derived from
 * it (`ChainDB`, `LedgerSnapshotStore`). Consumes `BlobStore` from
 * the outer scope — `main.ts`'s `LsmWorkerBrowser` provides it,
 * shared with the snapshot-upload handlers.
 */
export const browserStorageDerivedLayers = Layer.mergeAll(
  ChainDBLive,
  LedgerSnapshotStoreLive,
);

export const bootstrapSyncWithStateUpdates = Effect.gen(function* () {
  yield* pushNodeState({ status: "connecting" });
  yield* bootstrapSyncPipeline.pipe(
    Effect.tapError((err) => pushNodeState({ status: "error", lastError: String(err) })),
  );
});
