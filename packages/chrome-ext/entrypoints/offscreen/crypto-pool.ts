/**
 * Browser Worker pool for crypto verification (Phase D Step 4).
 *
 * Spawns N=4 dedicated Web Workers from the offscreen document, each
 * hosting an `RpcServer` for `CryptoRpcGroup` against
 * `BrowserWorkerRunner`. The pool dispatcher (built into Effect's
 * `RpcClient.layerProtocolWorker`) round-robins requests across the
 * workers, so the four parallel header-validation crypto checks
 * (VRF proof + leader threshold + KES sig + opcert ed25519) actually
 * run in parallel rather than interleaving on a single WASM
 * instance.
 *
 * Wave 4 Q4 background: only the offscreen document can spawn Web
 * Workers — the MV3 service worker cannot. The Phase D architecture
 * inversion (waves 13-15) put the offscreen in charge of the
 * Effect runtime + consensus driver, which is what unblocks this
 * pool.
 *
 * Pool size 4 matches the canonical 4-bucket Praos header validation
 * (Wave 4 + consensus/CLAUDE.md). Configurable via the build-time
 * `__CRYPTO_POOL_SIZE__` Vite define if a future iteration wants
 * to scale per-host.
 *
 * The Worker URL uses `import.meta.url` resolution — Vite (via WXT)
 * sees this construction at build time and emits a separate worker
 * chunk. The path is relative to the spawning module.
 */
import { Layer } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import type { WorkerError } from "effect/unstable/workers/WorkerError";
import type { Crypto } from "wasm-utils";
import { CryptoFromRpc, CryptoRpcClient } from "wasm-utils/rpc";

// Vite's `?worker` import suffix — bundles the file as a Web Worker
// chunk AND returns a constructor we can `new` directly. The
// alternative (`new Worker(new URL("./workers/X.ts", import.meta.url),
// …)`) is fragile under WXT v0.20: the URL constructor either gets
// inlined as a `data:video/mp2t;base64,…` URL (CSP-rejected in MV3)
// OR copied as a raw `.ts` asset (Strict-MIME-rejected as
// `video/mp2t`). `?worker` sidesteps both — Vite generates a
// proper `.js` chunk and serves it from the extension's own origin.
import CryptoWorker from "./workers/crypto-worker.ts?worker";

/** Auto-scaling pool configuration.
 *
 *   - `minSize: 1` keeps one worker warm so the first header verify
 *     after popup-open doesn't pay a cold-spawn cost.
 *   - `maxSize: navigator.hardwareConcurrency ?? 4` caps at the host's
 *     reported core count (typically 4-16 on desktop). Praos header
 *     validation runs 4 verifies in parallel per header; bursty
 *     workloads (catch-up sync) saturate them, idle workloads return
 *     to one. Wave 4 Q4 + the session-6 Worker research validated
 *     the parallelism gain.
 *   - `concurrency: 1` — one in-flight RPC per worker. wasm-bindgen
 *     instances aren't reentrant (single linear-memory heap); routing
 *     concurrent calls to one worker would serialise on the WASM
 *     boundary anyway. The pool dispatcher hands a fresh worker per
 *     request.
 *   - `targetUtilization: 0.8` — grow the pool when utilisation
 *     exceeds 80 %; shrink when it falls back. Hysteresis is built
 *     into Effect's `Pool.make`.
 *   - `timeToLive: "30 seconds"` — idle workers tear down after this
 *     window. Saves linear-memory pages when the popup is closed
 *     during long stalls.
 */
const POOL_OPTIONS = {
  minSize: 1,
  maxSize: globalThis.navigator?.hardwareConcurrency ?? 4,
  concurrency: 1,
  targetUtilization: 0.8,
  timeToLive: "30 seconds",
} as const;

/**
 * `Crypto` service backed by 4 dedicated browser Workers + RPC.
 * Provide once at the offscreen daemon entrypoint:
 *
 * ```ts
 * import { CryptoWorkerBrowser } from "./crypto-pool.ts";
 * Layer.mergeAll(CryptoWorkerBrowser, …)
 * ```
 *
 * Replaces `CryptoDirect` in the offscreen-side bootstrap-sync's
 * `browserLayers()` composition.
 */
export const CryptoWorkerBrowser: Layer.Layer<Crypto, WorkerError> = CryptoFromRpc.pipe(
  Layer.provide(CryptoRpcClient.layer),
  Layer.provide(RpcClient.layerProtocolWorker(POOL_OPTIONS)),
  Layer.provide(RpcSerialization.layerMsgPack),
  Layer.provide(BrowserWorker.layer(() => new CryptoWorker())),
);
