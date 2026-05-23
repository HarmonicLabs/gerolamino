/**
 * Offscreen-side sync pipeline.
 *
 * Runs in the offscreen document (Chrome MV3 WORKERS reason) as an
 * indefinite daemon. Two bootstrap paths:
 *
 *   - **local**: drag-drop a Mithril V2LSM snapshot (or Playwright OPFS
 *     seed from `.devenv/state/db`). The popup walks the directory via
 *     the File System Access API and streams bytes into the lsm-worker's
 *     OPFS; WASM lsm-tree opens against `/data/lsm/`, then relay sync
 *     resumes from the snapshot tip.
 *   - **genesis**: empty OPFS — sync from origin over the relay proxy.
 *
 * There is no remote/bootstrap-server ingestion path.
 *
 * Relay sync still flows through `${serverBase}/relay` — a WS→TCP
 * proxy is required because browsers can't open raw TCP sockets.
 * The proxy is out-of-tree (no longer bundled with this monorepo);
 * the URL is build-time configurable via `BOOTSTRAP_URL` env var.
 */
import { Cause, Effect, HashMap, Layer, Metric, Option, Ref, Schedule, Stream } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import {
  ChainEventStream,
  ChainEventsLive,
  ConsensusEvents,
  PeerManager,
  PeerManagerLayer,
  SlotClock,
  SlotClockPreprod,
  connectToRelayOnSocket,
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
  appendChainEvent,
  pushSyncSparklinePoint,
} from "./atoms.ts";
import { BlobStore, ChainDB, ChainDBLive, LedgerSnapshotStoreLive } from "storage";
import { loadSettings, type BootstrapSettings } from "../shared/bootstrap-settings.ts";
import { DEFAULT_RELAY_URL } from "../shared/relay-url.ts";
import { appendSessionLogLine } from "../shared/test-log-buffer.ts";
import { readLedgerStateFromOpfs } from "./snapshot-ingest.ts";
import { layer as OpfsFileSystemLayer } from "../../src/opfs/file-system.ts";
import { LsmRpcClient } from "./lsm-pool.ts";
import * as Metrics from "./metrics.ts";

export const bootstrapSyncPipeline = (seedSettings?: BootstrapSettings) =>
  Effect.gen(function* () {
  appendSessionLogLine("[offscreen-sync] Initializing WASM...");
  yield* Effect.log("[offscreen-sync] Initializing WASM...");
  const wasmInitStart = yield* Effect.clockWith((c) => c.currentTimeMillis);
  const wasmInitTimeout = Effect.fail(new Error("WASM init timed out after 60s"));
  yield* initWasm.pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      onTimeout: () => wasmInitTimeout,
    }),
    Effect.tap(() =>
      Effect.gen(function* () {
        const ms = Number((yield* Effect.clockWith((c) => c.currentTimeMillis)) - wasmInitStart);
        appendSessionLogLine(`[offscreen-sync] wasm-utils ready (${ms}ms)`);
        yield* Effect.log(`[offscreen-sync] wasm-utils ready (${ms}ms)`);
      }),
    ),
  );
  yield* Effect.promise(() => initWasmPlexer()).pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      onTimeout: () => wasmInitTimeout,
    }),
    Effect.tap(() => {
      appendSessionLogLine("[offscreen-sync] wasm-plexer ready");
      return Effect.log("[offscreen-sync] wasm-plexer ready");
    }),
  );
  const wasmDoneMs = Number((yield* Effect.clockWith((c) => c.currentTimeMillis)) - wasmInitStart);
  yield* Metric.update(Metrics.wasmInitLatencyMs, wasmDoneMs);
  yield* Metric.update(Metrics.wasmInitSuccess, 1);

  // Genesis boots skip the popup upload → `LsmReopenAfterUpload` path. Open the
  // chain-metadata lsm-tree session before ChainDB's boot-time scan / addBlock
  // so BlobStore ops don't race lazy-init or hit a closed table handle.
  yield* Effect.gen(function* () {
    const lsm = yield* LsmRpcClient;
    yield* lsm.LsmReopenAfterUpload({});
    appendSessionLogLine("[offscreen-sync] LSM chain-metadata session opened");
    yield* Effect.log("[offscreen-sync] LSM chain-metadata session opened");
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const line = `[offscreen-sync] LSM session open failed: ${Cause.pretty(cause)}`;
        appendSessionLogLine(line);
        yield* Effect.logWarning(line);
      }),
    ),
  );

  // Genesis / empty OPFS: force lazy lsm-tree open before ChainSync writes.
  yield* Effect.gen(function* () {
    const store = yield* BlobStore;
    yield* store.get(new Uint8Array([0xff])).pipe(Effect.ignore);
    appendSessionLogLine("[offscreen-sync] LSM BlobStore warmup complete");
    yield* Effect.log("[offscreen-sync] LSM BlobStore warmup complete");
  }).pipe(
    Effect.catchCause((cause) => {
      const line = `[offscreen-sync] LSM BlobStore warmup failed: ${String(cause)}`;
      appendSessionLogLine(line);
      return Effect.logWarning(line);
    }),
  );

  const persisted = seedSettings ?? (yield* loadSettings);
  const settings = persisted ?? {
    mode: "genesis" as const,
    serverUrl: DEFAULT_RELAY_URL,
  };
  const settingsSource = seedSettings
    ? "relayed at fork"
    : persisted
      ? "from chrome.storage.local"
      : "build-time defaults";
  const settingsLine =
    `[offscreen-sync] Settings: mode=${settings.mode}, relayUrl=${settings.serverUrl} ` +
    `(${settingsSource})`;
  appendSessionLogLine(settingsLine);
  yield* Effect.log(settingsLine);

  if (settings.mode === "local") {
    yield* Effect.log(
      "[offscreen-sync] Local-snapshot mode — relay sync resumes from the " +
        "lsm-tree session that the popup's drag-drop populated in OPFS " +
        "(`/data/lsm/`). If the session is empty, this collapses to a " +
        "genesis-style sync from the upstream relay.",
    );
  }

  const wsUrl = `${settings.serverUrl}/relay`;

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
    Effect.tapError((e) => {
      const line = `[offscreen-sync] OPFS ingest failed: ${e} — using genesis`;
      appendSessionLogLine(line);
      return Effect.logWarning(line).pipe(
        Effect.andThen(Metric.update(Metrics.opfsIngestFallback, 1)),
      );
    }),
    Effect.catch(() => Effect.succeed(undefined)),
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

  // Mirror apps/tui: drain ChainEventStream into the offscreen atom registry
  // so the broadcast fiber pushes chain events to the popup dashboard.
  const chainEvents = yield* ChainEventStream;
  yield* Effect.forkScoped(Stream.runForEach(chainEvents.stream, appendChainEvent));

  const monitorLoop = Effect.gen(function* () {
    const tickRef = yield* Ref.make(0);
    const lastTipRef = yield* Ref.make<string>("");
    const chainDb = yield* ChainDB;
    const slotClock = yield* SlotClock;
    yield* Effect.repeat(
      Effect.gen(function* () {
        const nodeStatus = yield* getNodeStatus(volatileRef);
        const peerManager = yield* PeerManager;
        const peers = yield* peerManager.getPeers;
        const tick = yield* Ref.updateAndGet(tickRef, (n) => n + 1);
        const tipStr = nodeStatus.tipSlot.toString();
        const lastTip = yield* Ref.get(lastTipRef);
        if (lastTip === "" && tipStr !== "0") {
          const firstTipLine =
            `[offscreen-sync] First tip observed: slot ${tipStr} (epoch ${nodeStatus.epochNumber}, ${nodeStatus.blocksProcessed} blocks processed)`;
          appendSessionLogLine(firstTipLine);
          yield* Effect.log(firstTipLine);
          yield* Ref.set(lastTipRef, tipStr);
        } else if (tick % 6 === 0) {
          yield* Effect.log(
            `[offscreen-sync] tip=${tipStr} epoch=${nodeStatus.epochNumber} sync=${nodeStatus.syncPercent}% gsm=${nodeStatus.gsmState} peers=${nodeStatus.peerCount}`,
          );
        }
        const slotsBehind = Number(nodeStatus.currentSlot - nodeStatus.tipSlot);
        yield* pushSyncSparklinePoint(slotsBehind >= 0 ? slotsBehind : 0);
        yield* pushNodeState({
          status: nodeStatus.syncPercent >= 100 ? "caught-up" : "syncing",
          tipSlot: nodeStatus.tipSlot,
          tipBlockNo: nodeStatus.tipBlockNo,
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
        if (
          tick % 6 === 0 &&
          nodeStatus.tipSlot > 0n &&
          nodeStatus.gsmState === "CaughtUp" &&
          ingest !== undefined
        ) {
          const tipOpt = yield* chainDb.getTip;
          if (Option.isSome(tipOpt)) {
            const k = BigInt(slotClock.config.securityParam);
            const gcBelow = tipOpt.value.slot > k ? tipOpt.value.slot - k : 0n;
            yield* chainDb.promoteToImmutable(tipOpt.value).pipe(
              Effect.catch((e) =>
                Effect.logWarning(`[offscreen-monitor] promoteToImmutable: ${e}`),
              ),
            );
            yield* chainDb.garbageCollect(gcBelow).pipe(
              Effect.catch((e) =>
                Effect.logWarning(`[offscreen-monitor] garbageCollect: ${e}`),
              ),
            );
          }
        }
      }).pipe(Effect.catch((e) => Effect.logWarning(`[offscreen-monitor] Check failed: ${e}`))),
      Schedule.fixed("10 seconds"),
    );
  });

  // Dashboard atom updates run for the whole bootstrap session — not tied to
  // one WebSocket attempt (reconnect must not kill the monitor fiber).
  yield* Effect.forkScoped(monitorLoop);

  // Fresh WebSocket per attempt — `connectToRelayOnSocket` uses the canonical
  // miniprotocol layer stack (clients ← Multiplexer ← Socket).
  yield* Effect.retry(
    Effect.gen(function* () {
      appendSessionLogLine(`[offscreen-sync] Connecting to relay proxy ${wsUrl}`);
      yield* Effect.log(`[offscreen-sync] Connecting to relay proxy ${wsUrl}`);
      const socket = yield* Socket.makeWebSocket(wsUrl);
      yield* Metric.update(Metrics.wsConnect, 1);
      appendSessionLogLine("[offscreen-sync] WebSocket connected");
      yield* Effect.log("[offscreen-sync] WebSocket connected");

      const syncStartLine =
        `[offscreen-sync] Starting Ouroboros miniprotocol sync over proxy (peerId=${peerId}; ` +
        `seeded=${ingest !== undefined ? "snapshot" : "genesis"})`;
      appendSessionLogLine(syncStartLine);
      yield* Effect.log(syncStartLine);

      yield* connectToRelayOnSocket(
        socket,
        peerId,
        PREPROD_MAGIC,
        ledgerView,
        snapshotState,
        volatileRef,
      ).pipe(
        Effect.catchCause((cause) => {
          const line = `[offscreen-sync] Error: ${Cause.pretty(cause)} — will retry`;
          appendSessionLogLine(line);
          return Effect.logWarning(line).pipe(
            Effect.andThen(pushNodeState({ status: "error", lastError: line })),
            Effect.andThen(Effect.failCause(cause)),
          );
        }),
      );
    }).pipe(
      Effect.tapError((err) => {
        const line = `[offscreen-sync] Connection failed (${String(err)}) — will reconnect`;
        appendSessionLogLine(line);
        return Effect.logWarning(line);
      }),
    ),
    Schedule.exponential("5 seconds", 2).pipe(Schedule.take(5)),
  ).pipe(
    Effect.tapError((err) => {
      const line = `[offscreen-sync] Relay session ended (${String(err)}) — backing off`;
      appendSessionLogLine(line);
      return Effect.logWarning(line);
    }),
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
  OpfsFileSystemLayer,
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

export const bootstrapSyncWithStateUpdates = (seedSettings?: BootstrapSettings) =>
  Effect.gen(function* () {
    appendSessionLogLine("[offscreen-sync] bootstrap-sync fiber started");
    yield* pushNodeState({ status: "connecting" });
    yield* bootstrapSyncPipeline(seedSettings).pipe(
      Effect.tapError((err) => pushNodeState({ status: "error", lastError: String(err) })),
    );
  });
