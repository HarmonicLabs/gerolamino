/**
 * Browser-Worker entrypoint for the Crypto RPC server (Phase D Step 4).
 *
 * The pool spawner in `../crypto-pool.ts` instantiates this script with
 * `new Worker(new URL("./workers/crypto-worker.ts", import.meta.url))`
 * — Vite (via WXT) bundles it as a separate chunk and rewrites the URL
 * at build time. Each worker process boots an `RpcServer` for
 * `CryptoRpcGroup` against the BrowserWorkerRunner transport, hosting
 * the same `wasm-utils` CryptoHandlersLive that the SW main thread
 * used to run inline.
 *
 * Wave 4 Q4 verdict: today's offscreen runs every crypto verify on a
 * single WASM instance; with N=4 workers + the pool dispatcher, the
 * 4 parallel header-validation crypto checks (VRF proof / leader /
 * KES / opcert) actually run in parallel rather than interleaving
 * fibers on a single worker.
 */
import * as BrowserWorkerRunner from "@effect/platform-browser/BrowserWorkerRunner";
import { Effect, Layer } from "effect";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { CryptoHandlersLive, CryptoRpcGroup } from "wasm-utils/rpc";

const WorkerLive = RpcServer.layer(CryptoRpcGroup).pipe(
  Layer.provide(CryptoHandlersLive),
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(BrowserWorkerRunner.layer),
);

Effect.runFork(Layer.launch(WorkerLive));
