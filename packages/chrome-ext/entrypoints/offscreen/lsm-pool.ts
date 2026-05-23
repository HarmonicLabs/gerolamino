/**
 * Single-Worker pool for the BlobStore-backed lsm-tree shim.
 *
 * Mirrors the crypto-worker pool (`./crypto-pool.ts`) but with
 * `POOL_SIZE = 1`. lsm-tree is single-writer; multiple workers
 * concurrently mutating the same OPFS-backed session would corrupt
 * the tree, so the worker count is fixed at one. A future read-only
 * pool could be added if a workload needs concurrent scans against
 * a frozen snapshot — out of scope for the initial cut.
 *
 * The pool exposes `BlobStore` (from `lsm-ffi`) so existing
 * consumers (`ChainDBLive`, `LedgerSnapshotStoreLive`) compose
 * unchanged. RPC transport faults map to `BlobStoreError` with
 * `operation: "lsm"` so the upstream error channel stays
 * homogeneous.
 *
 * Snapshot upload + reopen are also exposed via the same RpcClient
 * — consumers `yield* LsmRpcClient` and call `client.LsmUploadChunk`
 * / `client.LsmReopenAfterUpload` directly. The popup forwards
 * bytes from drag-drop through the SW relay to the offscreen, which
 * then RPCs into the worker.
 */
import { Context, Effect, Layer, Option, Schedule, Stream } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as BrowserWorker from "@effect/platform-browser/BrowserWorker";
import type { WorkerError } from "effect/unstable/workers/WorkerError";
import { type BlobEntry, BlobStore, BlobStoreError } from "lsm-ffi";
import { LsmRpcGroup } from "./lsm-rpc.ts";
import { layerLsmSingleWorkerProtocol } from "./lsm-worker-protocol.ts";

// Vite's `?worker` import suffix — Vite bundles `lsm-worker.ts` as a
// proper Web Worker chunk and returns a constructor. See the same
// pattern + the longer rationale in `crypto-pool.ts`.
import LsmWorker from "./workers/lsm-worker.ts?worker";

declare global {
  // eslint-disable-next-line no-var
  var __GEROLAMINO_LSM_WORKER_SINGLETON__: InstanceType<typeof LsmWorker> | undefined;
}

/** One physical Worker for the offscreen document. Module-level `let` is
 *  insufficient when Rolldown splits `lsm-pool` across chunks — each copy
 *  gets its own singleton and spawns another Worker (3× `writeChunk enter`). */
/** Terminate the singleton worker (E2E hermetic reset / recover wedged OPFS sync). */
export const terminateLsmWorkerSingleton = (): void => {
  const worker = globalThis.__GEROLAMINO_LSM_WORKER_SINGLETON__;
  if (worker !== undefined) {
    worker.terminate();
    globalThis.__GEROLAMINO_LSM_WORKER_SINGLETON__ = undefined;
  }
};

const spawnLsmWorker = (_id: number): InstanceType<typeof LsmWorker> => {
  if (globalThis.__GEROLAMINO_LSM_WORKER_SINGLETON__ === undefined) {
    globalThis.__GEROLAMINO_LSM_WORKER_SINGLETON__ = new LsmWorker();
  }
  return globalThis.__GEROLAMINO_LSM_WORKER_SINGLETON__;
};

/**
 * Service tag for the BlobStore-shaped RpcClient. Bound to the
 * worker-pool transport via `.layer`. Consumers needing the
 * non-BlobStore operations (`LsmUploadChunk`,
 * `LsmReopenAfterUpload`) yield this directly.
 */
export class LsmRpcClient extends Context.Service<
  LsmRpcClient,
  RpcClient.RpcClient<RpcGroup.Rpcs<typeof LsmRpcGroup>, RpcClientError>
>()("chrome-ext/LsmRpcClient") {
  static readonly layer = Layer.effect(LsmRpcClient)(RpcClient.make(LsmRpcGroup));
}

/** Lift a transport-layer error into `BlobStoreError`. The service
 *  signature is `Effect<_, BlobStoreError>` whether the layer is
 *  worker-backed or direct, so RPC clients map their wider error
 *  channel back at this seam. */
const wrapTransport = (cause: RpcClientError | BlobStoreError): BlobStoreError =>
  cause instanceof BlobStoreError
    ? cause
    : new BlobStoreError({ operation: "lsm", cause: `rpc transport: ${cause.message}` });

/** Bounded retry on the BlobStore client methods. Only retries
 *  `RpcClientError` (transport faults — e.g. Worker died under
 *  memory pressure and the Pool needs to re-spawn). Real
 *  `BlobStoreError`s from the worker (e.g. lsm-tree-side failure)
 *  fail immediately — retrying wouldn't help.
 *
 *  `Schedule.recurs(2)` = 3 attempts total (one original + two
 *  retries). Each retry gets a fresh `Pool.get()` which should
 *  pick a healthy worker; if all three attempts hit transport
 *  failures, the caller sees the last error as a `BlobStoreError`. */
const withTransportRetry = <A>(
  eff: Effect.Effect<A, RpcClientError | BlobStoreError>,
): Effect.Effect<A, BlobStoreError> =>
  eff.pipe(
    Effect.catchTag("RpcClientError", (transportError) =>
      eff.pipe(Effect.retry(Schedule.recurs(1)), Effect.mapError(() => transportError)),
    ),
    Effect.mapError(wrapTransport),
  );

/**
 * `BlobStore` service backed by the worker's `LsmRpcClient`. Method
 * signatures match the canonical `BlobStore` so consumers compose
 * unchanged.
 */
export const BlobStoreFromWorker: Layer.Layer<BlobStore, never, LsmRpcClient> = Layer.effect(
  BlobStore,
  Effect.gen(function* () {
    const client = yield* LsmRpcClient;
    return {
      get: (key: Uint8Array) =>
        withTransportRetry(client.LsmGet({ key })).pipe(
          Effect.map((v) => Option.fromNullishOr(v)),
        ),

      put: (key: Uint8Array, value: Uint8Array) =>
        withTransportRetry(client.LsmPut({ key, value })),

      delete: (key: Uint8Array) => withTransportRetry(client.LsmDelete({ key })),

      has: (key: Uint8Array) => withTransportRetry(client.LsmHas({ key })),

      scan: (prefix: Uint8Array) =>
        Stream.unwrap(
          withTransportRetry(client.LsmScan({ prefix })).pipe(
            Effect.map((entries) => Stream.fromIterable(entries)),
          ),
        ),

      putBatch: (entries: ReadonlyArray<BlobEntry>) =>
        withTransportRetry(client.LsmPutBatch({ entries })),

      deleteBatch: (keys: ReadonlyArray<Uint8Array>) =>
        withTransportRetry(client.LsmDeleteBatch({ keys })),
    };
  }),
);

/**
 * Full lsm-worker Layer — transport + RpcClient + BlobStore wrapper.
 * Provides both `BlobStore` (for `ChainDBLive` /
 * `LedgerSnapshotStoreLive` consumers) AND `LsmRpcClient` (for the
 * offscreen-RPC snapshot-upload handlers that call
 * `LsmUploadChunk` + `LsmReopenAfterUpload` directly).
 *
 * Both services share the SAME spawned Worker via Effect's Layer
 * memoization — `Layer.provideMerge(LsmRpcClient.layer)` keeps the
 * client tag exposed AND inside the BlobStore composition, so a
 * single transport instance backs both call paths.
 *
 * Plugs into `main.ts`'s shared `runtimeLayer`. Bootstrap-sync gets
 * `BlobStore` via `Layer.provide(runtimeLayer)`; the offscreen RPC
 * server gets `LsmRpcClient` from the same composition.
 *
 * Layer ordering mirrors `crypto-pool.ts`'s `CryptoWorkerBrowser`:
 * each `.pipe(Layer.provide(...))` step resolves the requirements
 * of the layer above it.
 */
export const LsmWorkerBrowser: Layer.Layer<BlobStore | LsmRpcClient, WorkerError> =
  BlobStoreFromWorker.pipe(
    Layer.provideMerge(LsmRpcClient.layer),
    Layer.provide(layerLsmSingleWorkerProtocol),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(BrowserWorker.layer(spawnLsmWorker)),
  );
