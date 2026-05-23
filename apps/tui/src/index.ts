/**
 * Gerolamino TUI node — sync-to-tip Cardano data node.
 *
 * Bootstraps from a local Mithril V2LSM snapshot directory
 * (`--snapshot-path`) or from genesis (`--genesis`). The bootstrap
 * server is gone (May 2026) — relay sync over `BunSocket.layerNet`
 * is the only way to reach the upstream cardano-node relay.
 * Storage flows through BlobStore (LSM-backed on Bun, IndexedDB-
 * backed on chrome-ext). No SQL — chain metadata, tip pointers,
 * snapshots, and nonces all live in BlobStore.
 *
 * Visualization:
 *   - **default**: mounts `Bun.WebView` on the bundled `packages/dashboard`
 *     SPA at `packages/dashboard/dist-spa/index.html`. The TUI pushes
 *     atom-state deltas into the webview by evaluating
 *     `window.__APPLY_DELTAS__(jsonString)` from a 16ms-cadence fiber.
 *   - **--headless**: skips the webview; the same atom state is dumped
 *     periodically via structured `Effect.log*` lines (10s cadence).
 *
 * Top-level wiring:
 *
 *   start command
 *     ├── chain-event drain       (Stream.fromPubSub → atom append, scoped)
 *     ├── visualization fiber     (WebView delta-push  OR  headless logger)
 *     └── parallel main loop      (relay sync + dashboardMonitorLoop)
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as BunWorker from "@effect/platform-bun/BunWorker";
import {
  Clock,
  Config,
  Effect,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Path,
  Ref,
  Schedule,
  Stream,
} from "effect";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as Socket from "effect/unstable/socket/Socket";
import { clamp, mapValues } from "es-toolkit";
import { Command, Flag } from "effect/unstable/cli";
import {
  ChainEventStream,
  ChainEventsLive,
  ConsensusEvents,
  getNodeStatus,
  PeerManager,
  PeerManagerLayer,
  SlotClockLiveFromEnvOrPreprod,
  connectToRelay,
  relayMiniprotocolLayers,
  RelayRetrySchedule,
  PREPROD_MAGIC,
  MAINNET_MAGIC,
  initialVolatileState,
  Nonces,
  extractLedgerView,
  extractNonces,
  extractSnapshotTip,
} from "consensus";
import { CryptoWorkerBun } from "wasm-utils/rpc/bun.ts";
import type { LedgerView } from "consensus";
import { decodeExtLedgerState } from "ledger";
import { readSnapshotMeta, readLedgerStateBytes } from "bootstrap";
import {
  type BlobEntry,
  BlobStore,
  stakeKey,
  ChainDBLive,
  LedgerSnapshotStoreLive,
} from "storage";
import { layerLsmWasm, lsmTreeJsffiUrl, lsmTreeWasmUrl, makeBunWasi } from "lsm-ffi";
import {
  registry,
  pushNodeState,
  pushBootstrapProgress,
  pushNetworkInfo,
  appendChainEvent,
} from "./dashboard/atoms.ts";
// Import atoms via the `dashboard/atoms` sub-path, NOT the main `dashboard`
// barrel. The barrel re-exports the DOM primitives + Solid components
// (Corvu / Kobalte / lucide-solid), and pulling those in under Bun (a
// non-DOM environment) triggers `solid-js/web/server.js`'s `notSup`
// stubs for client-only APIs at module-init time. The headless TUI only
// needs the pure-JS atom registry + push helpers; this sub-path stays
// host-agnostic.
import {
  nodeStateAtom,
  peersAtom,
  chainEventLogAtom,
  bootstrapAtom,
  pushSyncSparklinePoint,
} from "dashboard/atoms";
import { startDashboardServer } from "./dashboard/serve.ts";
import {
  MONITOR_LOOP_INTERVAL,
  HEADLESS_LOG_INTERVAL,
  MONITOR_RETRY_SPACING,
  DASHBOARD_PORT,
} from "./constants.ts";

// ───────────────────────────── SPA bundle ─────────────────────────────

/**
 * Path to the bundled dashboard SPA. Built by
 * `bun packages/dashboard/build.ts` to `packages/dashboard/dist-spa/`.
 */
// Bun-native path resolution + existence check — replaces `node:path`
// + `node:fs/promises` per the no-node:* rule. `import.meta.dir` and
// `Bun.file().exists()` are stdlib-equivalents in Bun runtime; both
// stay inside the Effect.tryPromise wrapper so failures land in the
// typed error channel.
const SPA_HTML_PATH = new URL(
  "../../../packages/dashboard/dist-spa/index.html",
  `file://${import.meta.dir}/`,
).pathname;

const ensureSpaBundle: Effect.Effect<void, Error> = Effect.tryPromise({
  try: async () => {
    const exists = await Bun.file(SPA_HTML_PATH).exists();
    if (!exists) throw new Error("missing");
  },
  catch: () =>
    new Error(
      `Dashboard SPA bundle not found at ${SPA_HTML_PATH}. ` +
        `Run \`bun packages/dashboard/build.ts\` to build it, ` +
        `or pass \`--headless\` to skip the WebView render path.`,
    ),
});

// ───────────────────────────── Ledger view ─────────────────────────────

/**
 * Genesis-mode "ledger view" — empty stake / pool maps. The consensus
 * layer's gentle-skip behavior (size === 0 → bypass) treats this as a
 * valid placeholder until enough blocks have been synced from the
 * relay to populate the stake distribution.
 */
const GENESIS_LEDGER_VIEW: LedgerView = {
  epochNonce: new Uint8Array(32),
  poolVrfKeys: HashMap.empty(),
  poolStake: HashMap.empty(),
  totalStake: 0n,
  activeSlotsCoeff: 0.05,
  maxKesEvolutions: 62,
  maxHeaderSize: 1100,
  maxBlockBodySize: 90112,
  ocertCounters: HashMap.empty(),
};

type SnapshotState = {
  tip: { slot: bigint; blockNo: bigint; hash: Uint8Array } | undefined;
  nonces: Nonces;
};

type BootstrapResult = {
  ledgerView: LedgerView;
  snapshotState: SnapshotState | undefined;
};

/**
 * Load + decode a Mithril V2LSM snapshot's `ledger/{slot}/state` file.
 *
 * Returns the consensus `LedgerView` (pool stake distribution, VRF
 * keys, opcert counters), the initial `Nonces` (active / evolving /
 * candidate / epoch), and the snapshot tip — everything the relay
 * sync loop needs to skip validation forward to the snapshot tip
 * before processing the first incoming header.
 *
 * Also writes the snapshot's stake distribution into BlobStore as
 * `STAKE_DISTR/<poolHash>` entries (8 BE bytes per pool), so the
 * mempool / ledger queries can resolve stake without re-decoding the
 * ledger state.
 */
const loadSnapshotState = (
  snapshotPath: string,
): Effect.Effect<
  BootstrapResult,
  unknown,
  FileSystem.FileSystem | Path.Path | BlobStore | import("consensus").SlotClock
> =>
  Effect.gen(function* () {
    yield* Effect.log(`Reading Mithril V2LSM snapshot from ${snapshotPath}`);
    yield* pushNodeState({ status: "bootstrapping" });

    const meta = yield* readSnapshotMeta(snapshotPath);
    yield* Effect.log(
      `Snapshot: slot ${meta.snapshotSlot}, magic ${meta.protocolMagic}, ` +
        `${meta.totalChunks} chunks`,
    );
    yield* pushBootstrapProgress({
      protocolMagic: meta.protocolMagic,
      snapshotSlot: meta.snapshotSlot,
      totalChunks: meta.totalChunks,
      phase: "awaiting-ledger-state",
    });

    const bytes = yield* readLedgerStateBytes(meta);
    yield* Effect.log(`Ledger state: ${bytes.length} bytes — decoding...`);
    yield* pushBootstrapProgress({
      ledgerStateReceived: true,
      phase: "decoding-ledger-state",
    });

    const extState = yield* decodeExtLedgerState(bytes);
    yield* Effect.log(
      `Decoded: era ${extState.currentEra}, epoch ${extState.newEpochState.epoch}, ` +
        `${HashMap.size(extState.newEpochState.poolDistr.pools)} pools`,
    );

    const ledgerView = yield* extractLedgerView(extState);
    const nonces = extractNonces(extState);
    const tip = extractSnapshotTip(extState);
    yield* Effect.log(
      `LedgerView: tip ${tip?.slot ?? "origin"}, totalStake ${ledgerView.totalStake}, ` +
        `${HashMap.size(ledgerView.poolVrfKeys)} VRF keys`,
    );

    // Materialise the snapshot's stake distribution into BlobStore so
    // mempool / queries can resolve `STAKE_DISTR/<poolHash>` without
    // re-decoding the (≥200 MB) ledger-state CBOR.
    const store = yield* BlobStore;
    const stakeEntries: Array<BlobEntry> = Array.from(
      HashMap.entries(ledgerView.poolStake),
      ([poolHashHex, stake]) => {
        const val = new Uint8Array(8);
        new DataView(val.buffer).setBigUint64(0, stake);
        return { key: stakeKey(Uint8Array.fromHex(poolHashHex)), value: val };
      },
    );
    if (stakeEntries.length > 0) {
      yield* store.putBatch(stakeEntries);
      yield* Effect.log(`Wrote ${stakeEntries.length} stake distribution entries`);
    }

    yield* pushBootstrapProgress({
      ledgerStateDecoded: true,
      totalAccounts: stakeEntries.length,
      totalStakeEntries: stakeEntries.length,
      phase: "complete",
    });

    return { ledgerView, snapshotState: { tip, nonces } };
  });

// ───────────────────────── Dashboard monitor loop ─────────────────────────

/**
 * 1Hz status push: reads node status + peer list + slot-distance and
 * mirrors them into the dashboard atom registry. Logs warnings on
 * stalled peers but otherwise silent — the "is this alive?" pulse
 * surface is the atom-driven dashboard, not log volume.
 *
 * The three atom writes per tick (`nodeStateAtom`, `peersAtom`,
 * `syncSparklineAtom`) are wrapped in `Atom.batch` so subscribers — the
 * WebView delta-push fiber, the headless logger, any in-process Solid
 * components — observe a single coherent post-state per tick. Without
 * batching, the delta-push fiber's 16ms cadence can race the writes
 * mid-tick and emit a partial-state JSON. The shared push helpers from
 * `dashboard/atoms` are sync `void`-returning functions, so they
 * compose cleanly inside `Atom.batch`'s synchronous callback — no
 * Effect-runtime threading needed. Clock is yielded once outside the
 * batch for the `lastUpdated` timestamp.
 */
const makeDashboardMonitorLoop = (volatileRef: Ref.Ref<ReturnType<typeof initialVolatileState>>) =>
  Effect.gen(function* () {
    const peerManager = yield* PeerManager;

    yield* Effect.repeat(
      Effect.gen(function* () {
        const nodeStatus = yield* getNodeStatus(volatileRef);
        const stalled = yield* peerManager.detectStalls;
        const peers = yield* peerManager.getPeers;
        const now = yield* Clock.currentTimeMillis;

        if (stalled.length > 0) {
          yield* Effect.logWarning(
            `Detected ${stalled.length} stalled peers: ${stalled.join(", ")}`,
          );
        }

        const slotsBehind = nodeStatus.currentSlot - nodeStatus.tipSlot;
        // `clamp` saturates pathological negative values (clock-skew tips)
        // at 0 and caps at safe-int so the sparkline accepts a JS number.
        const sparklinePoint = clamp(Number(slotsBehind), 0, Number.MAX_SAFE_INTEGER);
        const peerRows = peers.map((p) => ({
          id: p.peerId,
          address: p.address,
          status: p.status,
          ...(p.tip && { tipSlot: p.tip.slot }),
        }));

        yield* Effect.sync(() =>
          Atom.batch(() => {
            registry.update(nodeStateAtom, (prev) => ({
              ...prev,
              status: nodeStatus.syncPercent >= 100 ? ("caught-up" as const) : ("syncing" as const),
              tipSlot: nodeStatus.tipSlot,
              tipBlockNo: nodeStatus.tipBlockNo,
              currentSlot: nodeStatus.currentSlot,
              epochNumber: nodeStatus.epochNumber,
              gsmState: nodeStatus.gsmState,
              syncPercent: nodeStatus.syncPercent,
              blocksProcessed: nodeStatus.blocksProcessed,
              lastUpdated: now,
            }));
            registry.set(peersAtom, peerRows);
            // `pushSyncSparklinePoint` encapsulates the bounded-ring
            // append+cap; identical wire shape to the prior inline
            // `takeRight([...prev, point], cap)` but DRY-shared with
            // the chrome-ext SW's atom push path.
            pushSyncSparklinePoint(registry, sparklinePoint);
          }),
        );
      }).pipe(
        // `Effect.catch` is the v4 catch-all-typed-errors combinator;
        // defects (programming errors / panics) still propagate up the
        // scope and tear down the program.
        Effect.catch((e) => Effect.logWarning(`Monitor check failed: ${e}`)),
      ),
      Schedule.fixed(MONITOR_LOOP_INTERVAL),
    );
  });

// ───────────────────── Headless / WebView visualization ─────────────────────

/**
 * Headless visualization fiber — emits a structured `dashboard` log line
 * on `HEADLESS_LOG_INTERVAL` cadence. Annotations become JSON fields
 * under the default Effect logger, so a downstream log-aggregator gets
 * machine-parseable state without bespoke parsers.
 *
 * Annotation values are normalized through a single `mapValues` pass so
 * `bigint` values stringify uniformly (Effect's logger drops bigints
 * silently otherwise) and `number` values keep their native form for the
 * aggregator's typed parsing. One conversion site prevents the prior
 * pattern's per-field `.toString()` / `.toFixed()` repetition from
 * drifting if a future field is added.
 */
const stringifyAnnotation = (v: unknown): string | number =>
  typeof v === "bigint" ? v.toString() : typeof v === "number" ? v : String(v);

const headlessLogFiber = Effect.repeat(
  Effect.gen(function* () {
    const ns = registry.get(nodeStateAtom);
    const peers = registry.get(peersAtom);
    const events = registry.get(chainEventLogAtom);
    const boot = registry.get(bootstrapAtom);
    yield* Effect.logInfo("dashboard").pipe(
      Effect.annotateLogs(
        mapValues(
          {
            status: ns.status,
            gsm: ns.gsmState,
            tipSlot: ns.tipSlot,
            currentSlot: ns.currentSlot,
            epoch: ns.epochNumber,
            syncPct: Number(ns.syncPercent.toFixed(1)),
            blocks: ns.blocksProcessed,
            peers: peers.length,
            events: events.length,
            bootstrap: boot.phase,
          },
          stringifyAnnotation,
        ),
      ),
    );
  }),
  Schedule.fixed(HEADLESS_LOG_INTERVAL),
);

// ───────────────────────────── start command ─────────────────────────────

const start = Command.make(
  "start",
  {
    genesis: Flag.boolean("genesis").pipe(
      Flag.withAlias("g"),
      Flag.withDescription("Sync from genesis without seeding from a snapshot"),
      Flag.withDefault(false),
    ),
    relayHost: Flag.string("relay-host").pipe(
      Flag.withDescription("Upstream relay host"),
      Flag.withFallbackConfig(Config.string("RELAY_HOST")),
      Flag.withDefault("preprod-node.world.dev.cardano.org"),
    ),
    relayPort: Flag.integer("relay-port").pipe(
      Flag.withDescription("Upstream relay port"),
      Flag.withFallbackConfig(Config.number("RELAY_PORT")),
      Flag.withDefault(3001),
    ),
    network: Flag.string("network").pipe(
      Flag.withDescription("Cardano network (preprod|mainnet)"),
      Flag.withDefault("preprod"),
    ),
    headless: Flag.boolean("headless").pipe(
      Flag.withDescription(
        "Skip Bun.WebView mount; run as a pure-Effect node and dump dashboard state via Effect.log",
      ),
      Flag.withDefault(false),
    ),
    dataDir: Flag.string("data-dir").pipe(
      Flag.withDescription(
        "Persistent storage directory (LSM BlobStore). Default: fresh temp dir per run.",
      ),
      Flag.withFallbackConfig(Config.string("GEROLAMINO_DATA_DIR")),
      Flag.withDefault(""),
    ),
    snapshotPath: Flag.string("snapshot-path").pipe(
      Flag.withDescription(
        "Path to a Mithril V2LSM snapshot directory. When set, the LSM BlobStore opens " +
          "against the snapshot's lsm-tree session and relay sync resumes from the snapshot tip.",
      ),
      Flag.withFallbackConfig(Config.string("GEROLAMINO_SNAPSHOT_PATH")),
      Flag.withDefault(""),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      yield* Effect.log("Gerolamino TUI node starting...");
      yield* Effect.log(`Relay: ${config.relayHost}:${config.relayPort} (${config.network})`);
      yield* Effect.log(`Mode: ${config.headless ? "headless" : "dashboard"}`);

      // Pre-flight: fail fast in WebView mode if the SPA bundle is missing.
      if (!config.headless) {
        yield* ensureSpaBundle;
      }

      yield* pushNetworkInfo({
        network: config.network === "mainnet" ? "mainnet" : "preprod",
        protocolMagic: config.network === "mainnet" ? 764824073 : 1,
        relayHost: config.relayHost,
        relayPort: config.relayPort,
      });

      // Bootstrap-source selection:
      //   --snapshot-path <dir>: open lsm-tree session against the
      //     on-disk Mithril V2LSM snapshot AND decode
      //     `<dir>/ledger/{slot}/state` (CBOR ExtLedgerState) to seed
      //     `LedgerView` + `Nonces` + tip directly. Requires
      //     WASM lsm-tree session under `<dir>/lsm/`. Ledger-state decode
      //     is independent of the BlobStore backend.
      //   --genesis (or no snapshot): sync from origin over the
      //     relay; `LedgerView` is empty until enough blocks land to
      //     populate it.
      yield* pushNodeState({ status: "connecting" });
      // Try snapshot ingest first, fall back to genesis on any
      // decode failure. The Cardano ledger schemas evolve faster
      // than this package's typed decoders — when the snapshot's
      // CBOR shape drifts ahead of the schema, we log a warning
      // and continue with an empty LedgerView. Consensus's
      // gentle-skip behavior (poolStake.size === 0 → bypass)
      // makes the resulting node correct-but-slow: relay sync
      // still happens, header validation falls through, and the
      // LSM session opens against the on-disk snapshot directly
      // so ChainDB queries hit pre-populated data immediately.
      const { ledgerView, snapshotState } =
        config.snapshotPath !== ""
          ? yield* loadSnapshotState(config.snapshotPath).pipe(
              Effect.tapError((e) =>
                Effect.logWarning(
                  `Snapshot ingest failed (${String(e)}). Falling back to genesis LedgerView; ` +
                    `consensus will catch up over the relay. The LSM session still opens ` +
                    `against ${config.snapshotPath}.`,
                ),
              ),
              Effect.catch(() =>
                pushBootstrapProgress({
                  phase: "complete",
                  ledgerStateDecoded: false,
                }).pipe(
                  Effect.as<BootstrapResult>({
                    ledgerView: GENESIS_LEDGER_VIEW,
                    snapshotState: undefined,
                  }),
                ),
              ),
            )
          : (yield* Effect.log("Genesis mode: syncing from origin"),
            { ledgerView: GENESIS_LEDGER_VIEW, snapshotState: undefined } as BootstrapResult);
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

      const status = yield* getNodeStatus(volatileRef);
      yield* Effect.log(`Tip: slot ${status.tipSlot} / ${status.currentSlot}`);
      yield* Effect.log(`Epoch: ${status.epochNumber}`);
      yield* Effect.log(`Sync: ${status.syncPercent}%`);
      yield* Effect.log(`GSM: ${status.gsmState}`);

      yield* pushNodeState({
        status: "syncing",
        tipSlot: status.tipSlot,
        tipBlockNo: status.tipBlockNo,
        currentSlot: status.currentSlot,
        epochNumber: status.epochNumber,
        gsmState: status.gsmState,
        syncPercent: status.syncPercent,
      });

      const networkMagic = config.network === "mainnet" ? MAINNET_MAGIC : PREPROD_MAGIC;
      const peerId = `${config.relayHost}:${config.relayPort}`;

      // ChainEventStream → dashboard atom drain. `Stream.fromPubSub`
      // manages the subscription internally (acquires on first pull,
      // releases on stream completion / interrupt) — no manual
      // `events.subscribe` lifecycle needed.
      const events = yield* ChainEventStream;
      yield* Effect.forkScoped(Stream.runForEach(events.stream, appendChainEvent));

      // Visualization fork — Bun.WebView (default) or headless logger.
      // Both run inside the program's enclosing scope; teardown is
      // automatic on Effect program exit (Ctrl-C, defect, scope error).
      if (config.headless) {
        yield* Effect.forkScoped(headlessLogFiber);
      } else {
        // `startDashboardServer` ends in `Layer.launch`, which blocks
        // forever — fork it so the rest of the program (consensus,
        // monitor loop) can continue. Scope-tied teardown still applies.
        yield* Effect.forkScoped(startDashboardServer);
        // Structured-log heartbeat alongside the HTTP server. Without it
        // the terminal looks frozen between startup and shutdown, since
        // the relay-sync driver doesn't log per-block.
        yield* Effect.forkScoped(headlessLogFiber);
        yield* Effect.log(
          `Dashboard ready at http://localhost:${DASHBOARD_PORT}/ — open in any browser`,
        );
      }

      // Connect to upstream relay with exponential backoff reconnection.
      // Monitor loop runs in parallel alongside relay sync.
      yield* Effect.all(
        [
          Effect.retry(
            connectToRelay(peerId, networkMagic, ledgerView, snapshotState, volatileRef).pipe(
              Effect.provide(
                relayMiniprotocolLayers(
                  BunSocket.layerNet({ host: config.relayHost, port: config.relayPort }),
                ),
                { local: true },
              ),
              Effect.tapError((e) =>
                Effect.logWarning(`Relay connection lost: ${e}. Reconnecting...`),
              ),
            ),
            RelayRetrySchedule,
          ),
          makeDashboardMonitorLoop(volatileRef).pipe(
            Effect.retry(Schedule.spaced(MONITOR_RETRY_SPACING)),
          ),
        ],
        { concurrency: "unbounded" },
      );
    }).pipe(
      // When `--snapshot-path` is set, route storage to that directory
      // — the LSM session opens against the Mithril V2LSM snapshot tree
      // (expects `<path>/lsm/active/`, `<path>/lsm/metadata`,
      // `<path>/lsm/snapshots/`). Otherwise fall back to `--data-dir`
      // (default fresh temp dir).
      Effect.provide(
        makeStorageLayers(config.snapshotPath || config.dataDir || undefined),
      ),
      // Wrap the entire program so the chain-event Stream's Scope is
      // satisfied. Forked fibers (`Effect.forkScoped`) inherit this scope
      // and are interrupted cleanly on program exit.
      Effect.scoped,
    ),
).pipe(Command.withDescription("Start the Gerolamino data node"));

const app = Command.make("gerolamino").pipe(
  Command.withDescription("Gerolamino: sync-to-tip Cardano data node"),
  Command.withSubcommands([start]),
);

// ───────────────────────────── Layer wiring ─────────────────────────────

/**
 * Build storage layers — BlobStore + BlobStore-backed ChainDB +
 * LedgerSnapshotStore. If `dataDir` is provided, LSM lives there
 * persistently for crash-recovery and E2E test harnesses. Without it,
 * a fresh temp directory is allocated per process start.
 *
 * BlobStore uses the Haskell-compiled lsm-tree WASM reactor
 * (`packages/wasm-utils/haskell-lsm/lsm-tree-wasm-shim/`). Override
 * artefact paths with `WASM_LSM_MODULE_PATH` / `WASM_LSM_JSFFI_PATH`.
 */
const makeStorageLayers = (dataDir: string | undefined) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const p = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;

      const baseDir = yield* dataDir
        ? fs.makeDirectory(dataDir, { recursive: true }).pipe(Effect.as(dataDir))
        : fs.makeTempDirectory({ prefix: "gerolamino-" });
      const lsmDir = p.join(baseDir, "lsm");
      yield* fs.makeDirectory(lsmDir, { recursive: true });

      const blobStoreLayer = yield* makeWasmLsmLayer(lsmDir);
      const chainDbLayer = ChainDBLive.pipe(Layer.provide(blobStoreLayer));
      const snapshotStoreLayer = LedgerSnapshotStoreLive.pipe(Layer.provide(blobStoreLayer));

      return Layer.mergeAll(chainDbLayer, snapshotStoreLayer, blobStoreLayer);
    }),
  );

/** Resolve WASM artefact path from env or packaged shim URLs. */
const resolveWasmLsmPath = (
  envKey: "WASM_LSM_MODULE_PATH" | "WASM_LSM_JSFFI_PATH",
  defaultUrl: URL,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fromConfig = yield* Config.string(envKey).pipe(
      Config.option,
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    return yield* Option.match(fromConfig, {
      onNone: () => path.fromFileUrl(defaultUrl),
      onSome: (p) => Effect.succeed(p),
    });
  });

/** Build the WASM lsm-tree BlobStore Layer via Bun WASI + reactor module. */
const makeWasmLsmLayer = (dataDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const wasmPath = yield* resolveWasmLsmPath("WASM_LSM_MODULE_PATH", lsmTreeWasmUrl);
    const jsffiPath = yield* resolveWasmLsmPath("WASM_LSM_JSFFI_PATH", lsmTreeJsffiUrl);
    const rawBytes = yield* fs.readFile(wasmPath);
    // Defensive copy into a fresh ArrayBuffer-backed Uint8Array — Bun's
    // `fs.readFile` returns a `Uint8Array<ArrayBufferLike>` whose backing
    // store can be `SharedArrayBuffer`. `WebAssembly.compile`'s
    // `BufferSource` type rejects that, so we materialise a clean copy.
    const wasmBytes = new Uint8Array(new ArrayBuffer(rawBytes.byteLength));
    wasmBytes.set(rawBytes);
    const jsffiModule: { default: (e: Record<string, unknown>) => WebAssembly.ModuleImports } =
      yield* Effect.promise(() => import(jsffiPath));
    const wasi = makeBunWasi({ preopens: { "/": dataDir } });
    return layerLsmWasm({
      wasmBytes,
      jsffiFactory: jsffiModule.default,
      wasi,
      sessionDir: "/",
    }).pipe(Layer.orDie);
  });

const slotClockLayer = SlotClockLiveFromEnvOrPreprod;
const peerManagerLayer = PeerManagerLayer.pipe(Layer.provide(slotClockLayer));

// BunWorker provides WorkerPlatform + Spawner for the Effect Worker pool.
// Each worker spawns crypto-worker.ts in a separate OS thread for true
// WASM parallelism (ed25519 + KES + VRF verifies).
const workerLayer = BunWorker.layer(
  (_id) => new Worker(new URL("../../../packages/consensus/src/crypto-worker.ts", import.meta.url)),
);

// Consensus + chain-event-log + UI event bus + clock + peers + crypto +
// platform socket constructor + Bun FileSystem/Path/Config. Single merge
// site so the entrypoint is one `Effect.provide` (pipe-style composition).
// `ChainEventsLive` is self-contained (memory journal + subtle encryption +
// generated identity); apps that want durable persistence swap the inner
// `EventJournal.layerMemory` for a SQL-backed journal at this layer.
const runtimeLayer = Layer.mergeAll(
  CryptoWorkerBun.pipe(Layer.provide(workerLayer)),
  slotClockLayer,
  peerManagerLayer,
  ChainEventsLive,
  ConsensusEvents.Live,
  Socket.layerWebSocketConstructorGlobal,
  BunServices.layer,
);

app.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(runtimeLayer),
  BunRuntime.runMain,
);
