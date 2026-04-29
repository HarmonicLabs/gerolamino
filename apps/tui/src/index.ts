/**
 * Gerolamino TUI node — sync-to-tip Cardano data node.
 *
 * Bootstraps remotely from a bootstrap server via WebSocket, then
 * validates headers via the consensus layer, stores data via BlobStore
 * (LSM) + SQL.
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
 *     ├── runBootstrap            (one-shot; extracts LedgerView + Nonces)
 *     │       └── BlobStore put/putBatch + dashboard atom pushes
 *     ├── chain-event drain       (Stream.fromPubSub → atom append, scoped)
 *     ├── visualization fiber     (WebView delta-push  OR  headless logger)
 *     └── parallel main loop      (relay sync + dashboardMonitorLoop)
 *
 * SQL access:
 *   layerBunSqlClient → SqlClient
 *     → runMigrations (consumes SqlClient) — creates tables
 *     → ChainDBLive (consumes BlobStore + SqlClient) → ChainDB
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
  Path,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as Socket from "effect/unstable/socket/Socket";
import { mapValues, takeRight } from "es-toolkit";
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
  RelayRetrySchedule,
  PREPROD_MAGIC,
  MAINNET_MAGIC,
  extractLedgerView,
  extractNonces,
  extractSnapshotTip,
  initialVolatileState,
  Nonces,
} from "consensus";
import { CryptoWorkerBun } from "wasm-utils/rpc/bun.ts";
import type { LedgerView } from "consensus";
import { decodeExtLedgerState } from "ledger";
import { connect, BootstrapMessage } from "bootstrap";
import {
  type BlobEntry,
  BlobStore,
  PREFIX_UTXO,
  blockKey,
  stakeKey,
  ChainDBLive,
  LedgerSnapshotStoreLive,
  runMigrations,
} from "storage";
import { layer as layerBunSqlClient } from "@effect/sql-sqlite-bun/SqliteClient";
import { layerLsm } from "lsm-ffi/lsm";
import { concat } from "consensus";
import { resolve } from "node:path";
import { access } from "node:fs/promises";
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
  syncSparklineAtom,
  SYNC_SPARKLINE_CAP,
} from "dashboard/atoms";
import { startDashboardServer } from "./dashboard/serve.ts";
import {
  UTXO_LOG_INTERVAL,
  BLOCK_LOG_INTERVAL,
  MONITOR_LOOP_INTERVAL,
  HEADLESS_LOG_INTERVAL,
  MONITOR_RETRY_SPACING,
  DASHBOARD_PORT,
} from "./constants.ts";

// ───────────────────────────── Types ─────────────────────────────

/** Bootstrap completed without receiving the expected LedgerState message. */
class BootstrapMissingLedgerState extends Schema.TaggedErrorClass<BootstrapMissingLedgerState>()(
  "BootstrapMissingLedgerState",
  {},
) {}

type SnapshotState = {
  tip: { slot: bigint; blockNo: bigint; hash: Uint8Array } | undefined;
  nonces: ReturnType<typeof extractNonces>;
};

type BootstrapResult = {
  ledgerView: LedgerView;
  snapshotState: SnapshotState | undefined;
};

// ───────────────────────────── SPA bundle ─────────────────────────────

/**
 * Path to the bundled dashboard SPA. Built by
 * `bun packages/dashboard/build.ts` to `packages/dashboard/dist-spa/`.
 */
const SPA_HTML_PATH = resolve(import.meta.dir, "../../../packages/dashboard/dist-spa/index.html");

const ensureSpaBundle: Effect.Effect<void, Error> = Effect.tryPromise({
  try: () => access(SPA_HTML_PATH),
  catch: () =>
    new Error(
      `Dashboard SPA bundle not found at ${SPA_HTML_PATH}. ` +
        `Run \`bun packages/dashboard/build.ts\` to build it, ` +
        `or pass \`--headless\` to skip the WebView render path.`,
    ),
});

// ───────────────────────────── Bootstrap ─────────────────────────────

/**
 * Genesis-mode "ledger view" — empty stake / pool maps. Used when the
 * `--genesis` flag is set; the consensus layer's gentle-skip behavior
 * (size === 0 → bypass) makes this a valid placeholder until enough
 * blocks have been synced to populate stake distribution.
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

/**
 * Run the full bootstrap stream end-to-end:
 *   1. Open the WebSocket to the bootstrap server.
 *   2. Process Init / LedgerState / BlobEntries / Block / Complete messages.
 *   3. Decode `ExtLedgerState` once it arrives, extract `LedgerView`
 *      + initial `Nonces` + snapshot tip.
 *   4. Persist the stake distribution to the BlobStore.
 *
 * Pure side-effecting Effect — does not fork. The caller awaits its
 * completion before starting the relay sync loop because both the
 * `LedgerView` and `Nonces` are required to validate the first relay
 * header.
 */
const runBootstrap = (bootstrapUrl: string) =>
  Effect.gen(function* () {
    yield* Effect.log(`Connecting to bootstrap server: ${bootstrapUrl}`);
    yield* pushNodeState({ status: "bootstrapping" });
    const store = yield* BlobStore;

    const blobCountRef = yield* Ref.make(0);
    const blockCountRef = yield* Ref.make(0);
    const ledgerViewRef = yield* Ref.make<LedgerView | undefined>(undefined);
    const snapshotStateRef = yield* Ref.make<SnapshotState | undefined>(undefined);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const stream = yield* connect(bootstrapUrl);

        yield* stream.pipe(
          Stream.runForEach(
            BootstrapMessage.match({
              Init: (m) =>
                Effect.gen(function* () {
                  yield* Effect.log(
                    `Bootstrap: slot ${m.snapshotSlot}, magic ${m.protocolMagic}, ${m.totalChunks} chunks`,
                  );
                  yield* pushBootstrapProgress({
                    protocolMagic: m.protocolMagic,
                    totalChunks: m.totalChunks,
                    phase: "awaiting-ledger-state",
                  });
                }),

              LedgerState: (m) =>
                Effect.gen(function* () {
                  yield* Effect.log(`Ledger state: ${m.payload.length} bytes, decoding...`);
                  const extState = yield* decodeExtLedgerState(m.payload);
                  yield* Effect.log(
                    `Decoded: era ${extState.currentEra}, epoch ${extState.newEpochState.epoch}, ` +
                      `${HashMap.size(extState.newEpochState.poolDistr.pools)} pools`,
                  );

                  const lv = yield* extractLedgerView(extState);
                  const nonces = extractNonces(extState);
                  const tip = extractSnapshotTip(extState);
                  yield* Ref.set(ledgerViewRef, lv);
                  yield* Ref.set(snapshotStateRef, { tip, nonces });

                  yield* Effect.log(
                    `Bootstrap: tip slot ${tip?.slot ?? "origin"}, totalStake ${lv.totalStake}, ` +
                      `${HashMap.size(lv.poolVrfKeys)} VRF keys loaded`,
                  );
                  yield* pushBootstrapProgress({ ledgerStateReceived: true });
                }),

              LedgerMeta: (m) => Effect.log(`Ledger meta: ${m.payload.length} bytes`),

              BlobEntries: (m) =>
                Effect.gen(function* () {
                  yield* store.putBatch(
                    m.entries.map((e) => ({
                      key: concat(PREFIX_UTXO, e.key),
                      value: e.value,
                    })),
                  );
                  const newCount = yield* Ref.updateAndGet(blobCountRef, (n) => n + m.count);
                  if (newCount % UTXO_LOG_INTERVAL === 0) {
                    yield* Effect.log(`UTxO entries received: ${newCount}`);
                    yield* pushBootstrapProgress({
                      blobEntriesReceived: newCount,
                      phase: "receiving-utxos",
                    });
                  }
                }),

              Block: (m) =>
                Effect.gen(function* () {
                  yield* store.put(blockKey(m.slotNo, m.headerHash), m.blockCbor);
                  const newCount = yield* Ref.updateAndGet(blockCountRef, (n) => n + 1);
                  if (newCount % BLOCK_LOG_INTERVAL === 0) {
                    yield* Effect.log(`Blocks received: ${newCount}`);
                    yield* pushBootstrapProgress({
                      blocksReceived: newCount,
                      phase: "receiving-blocks",
                    });
                  }
                }),

              Progress: (m) => Effect.log(`Progress: ${m.phase} ${m.current}/${m.total}`),

              Complete: () =>
                Effect.gen(function* () {
                  const blobCount = yield* Ref.get(blobCountRef);
                  const blockCount = yield* Ref.get(blockCountRef);
                  yield* Effect.log(
                    `Bootstrap complete: ${blobCount} UTxO entries, ${blockCount} blocks`,
                  );
                  yield* pushBootstrapProgress({
                    blobEntriesReceived: blobCount,
                    blocksReceived: blockCount,
                    phase: "complete",
                  });
                }),
            }),
          ),
        );
      }),
    );

    const lv = yield* Ref.get(ledgerViewRef);
    if (!lv) return yield* new BootstrapMissingLedgerState();

    // Populate stake distribution table from LedgerView
    const stakeEntries: Array<BlobEntry> = [];
    for (const [poolHashHex, stake] of lv.poolStake) {
      const val = new Uint8Array(8);
      new DataView(val.buffer).setBigUint64(0, stake);
      stakeEntries.push({ key: stakeKey(Uint8Array.fromHex(poolHashHex)), value: val });
    }
    if (stakeEntries.length > 0) {
      yield* store.putBatch(stakeEntries);
      yield* Effect.log(`Wrote ${stakeEntries.length} stake distribution entries`);
    }

    return {
      ledgerView: lv,
      snapshotState: yield* Ref.get(snapshotStateRef),
    };
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
 * mid-tick and emit a partial-state JSON. Raw registry mutations are
 * used inside the batch (vs `pushPeers` / `pushSyncSparklinePoint`
 * Effects) so the synchronous `Atom.batch` callback doesn't need to
 * thread an Effect runtime through three nested `runSync` calls; Clock
 * is yielded once outside the batch for the `lastUpdated` timestamp.
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
        const sparklinePoint = Number(slotsBehind < 0n ? 0n : slotsBehind);
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
            registry.set(
              syncSparklineAtom,
              takeRight([...registry.get(syncSparklineAtom), sparklinePoint], SYNC_SPARKLINE_CAP),
            );
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
    bootstrapUrl: Flag.string("bootstrap-url").pipe(
      Flag.withAlias("b"),
      Flag.withDescription("Bootstrap server WebSocket URL"),
      Flag.withFallbackConfig(Config.string("BOOTSTRAP_SERVER_URL")),
      Flag.withDefault("ws://localhost:3040/bootstrap"),
    ),
    genesis: Flag.boolean("genesis").pipe(
      Flag.withAlias("g"),
      Flag.withDescription("Sync from genesis (no bootstrap server needed)"),
      Flag.withDefault(false),
    ),
    relayHost: Flag.string("relay-host").pipe(
      Flag.withDescription("Upstream relay host"),
      Flag.withFallbackConfig(Config.string("RELAY_HOST")),
      Flag.withDefault("preprod-node.play.dev.cardano.org"),
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
        "Persistent storage directory (LSM + SQLite). Default: fresh temp dir per run.",
      ),
      Flag.withFallbackConfig(Config.string("GEROLAMINO_DATA_DIR")),
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

      yield* runMigrations;
      yield* Effect.log("Database migrations complete.");

      const { ledgerView, snapshotState } = yield* config.genesis
        ? Effect.gen(function* () {
            yield* Effect.log("Genesis mode: syncing from origin (no bootstrap)");
            yield* pushNodeState({ status: "connecting" });
            return { ledgerView: GENESIS_LEDGER_VIEW, snapshotState: undefined } as BootstrapResult;
          })
        : runBootstrap(config.bootstrapUrl);

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
                BunSocket.layerNet({ host: config.relayHost, port: config.relayPort }),
              ),
              Effect.scoped,
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
      Effect.provide(makeStorageLayers(config.dataDir || undefined)),
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
 * Build storage layers with LSM BlobStore + SQLite ChainDB.
 *
 * If `dataDir` is provided, LSM and SQLite live there persistently — for
 * crash-recovery and E2E test harnesses. Without it, a fresh temp
 * directory is allocated per process start (matches the prior
 * bootstrap-stream-only flow).
 */
const makeStorageLayers = (dataDir: string | undefined) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const p = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;

      const baseDir = yield* dataDir
        ? Effect.gen(function* () {
            yield* fs.makeDirectory(dataDir, { recursive: true });
            return dataDir;
          })
        : fs.makeTempDirectory({ prefix: "gerolamino-" });
      const lsmDir = p.join(baseDir, "lsm");
      yield* fs.makeDirectory(lsmDir, { recursive: true });

      const blobStoreLayer = layerLsm(lsmDir);
      const sqlClientLayer = layerBunSqlClient({ filename: p.join(baseDir, "chain.db") });

      const storageDepsLayer = Layer.merge(blobStoreLayer, sqlClientLayer);
      const chainDbLayer = ChainDBLive.pipe(Layer.provide(storageDepsLayer));
      const snapshotStoreLayer = LedgerSnapshotStoreLive.pipe(Layer.provide(storageDepsLayer));

      return Layer.mergeAll(chainDbLayer, snapshotStoreLayer, sqlClientLayer, blobStoreLayer);
    }),
  );

const slotClockLayer = SlotClockLiveFromEnvOrPreprod;
const peerManagerLayer = PeerManagerLayer.pipe(Layer.provide(slotClockLayer));

// BunWorker provides WorkerPlatform + Spawner for the Effect Worker pool.
// Each worker spawns crypto-worker.ts in a separate OS thread for true
// WASM parallelism (ed25519 + KES + VRF verifies).
const workerLayer = BunWorker.layer(
  (_id) => new Worker(new URL("../../../packages/consensus/src/crypto-worker.ts", import.meta.url)),
);

// Consensus + chain-event-log + UI event bus + clock + peers + crypto.
// `ChainEventsLive` is self-contained (memory journal + subtle encryption +
// generated identity); apps that want durable persistence swap the inner
// `EventJournal.layerMemory` for a SQL-backed journal at this layer.
const consensusLayers = Layer.mergeAll(
  CryptoWorkerBun.pipe(Layer.provide(workerLayer)),
  slotClockLayer,
  peerManagerLayer,
  ChainEventsLive,
  ConsensusEvents.Live,
);

app.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(consensusLayers),
  Effect.provide(Socket.layerWebSocketConstructorGlobal),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
