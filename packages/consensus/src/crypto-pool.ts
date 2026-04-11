/**
 * CryptoWorkerPool — Effect Worker pool for CPU-bound WASM crypto.
 *
 * Each worker runs in a separate OS thread with its own WASM instance.
 * Pool auto-sizes to `navigator.hardwareConcurrency` (all available cores).
 * Concurrency per worker = 1 (WASM calls are synchronous/blocking).
 *
 * Uses Effect Worker system (effect/unstable/workers) with platform-provided
 * WorkerPlatform + Spawner layers. The TUI provides BunWorker.layer;
 * the browser extension provides BrowserWorker.layer.
 */
import { Config, Deferred, Effect, Layer, Pool, Ref, ServiceMap } from "effect";
import * as Worker from "effect/unstable/workers/Worker";
import { WorkerError } from "effect/unstable/workers/WorkerError";
import { CryptoRequest, type CryptoResponse } from "./crypto-protocol.ts";

/** Safe ArrayBuffer extraction — skips SharedArrayBuffer (not transferable). */
const toTransferable = (buf: ArrayBufferLike): ArrayBuffer | undefined =>
  buf instanceof SharedArrayBuffer ? undefined : buf;

// ---------------------------------------------------------------------------
// CryptoWorkerPool service tag
// ---------------------------------------------------------------------------

export class CryptoWorkerPool extends ServiceMap.Service<
  CryptoWorkerPool,
  {
    readonly dispatch: (request: CryptoRequest) => Effect.Effect<CryptoResponse, WorkerError>;
  }
>()("consensus/CryptoWorkerPool") {}

// ---------------------------------------------------------------------------
// Pool construction + dispatch
// ---------------------------------------------------------------------------

/** Auto-detect worker count: all available cores, overridable via CRYPTO_WORKERS env. */
const workerCount = Config.int("CRYPTO_WORKERS").pipe(
  Config.withDefault(globalThis.navigator?.hardwareConcurrency ?? 4),
);

/**
 * CryptoWorkerPool layer — requires Worker.WorkerPlatform + Worker.Spawner
 * from the environment. These are provided by platform-specific layers:
 * - Bun: `BunWorker.layer(spawn)` from @effect/platform-bun
 * - Browser: `BrowserWorker.layer(spawn)` from @effect/platform-browser
 */
export const CryptoWorkerPoolLive: Layer.Layer<
  CryptoWorkerPool,
  never,
  Worker.WorkerPlatform | Worker.Spawner
> = Layer.effect(
  CryptoWorkerPool,
  Effect.gen(function* () {
    const count = yield* workerCount;
    const platform = yield* Worker.WorkerPlatform;
    const nextIdRef = yield* Ref.make(0);

    // Create a pool of workers, each with concurrency: 1
    // (WASM calls block the worker's JS thread synchronously)
    const pool = yield* Pool.make({
      acquire: Effect.gen(function* () {
        const id = yield* Ref.getAndUpdate(nextIdRef, (n) => n + 1);
        return yield* platform.spawn<CryptoResponse, CryptoRequest>(id);
      }),
      size: count,
      concurrency: 1,
    });

    const dispatch = (request: CryptoRequest): Effect.Effect<CryptoResponse, WorkerError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* Pool.get(pool);
          const result = yield* Deferred.make<CryptoResponse, WorkerError>();

          // Start listening for response, then send request
          yield* Effect.forkChild(
            worker.run(
              (response) => Deferred.succeed(result, response),
              { onSpawn: Effect.void },
            ),
          );

          // Transfer ArrayBuffer ownership for zero-copy send.
          // Collect Uint8Array fields per request kind for transfer.
          const collectBuffers = (bufs: ArrayBufferLike[]): ArrayBuffer[] =>
            bufs.flatMap((b) => { const t = toTransferable(b); return t ? [t] : []; });

          const transfers: ArrayBuffer[] = CryptoRequest.match(request, {
            VrfVerifyProof: (r) => collectBuffers([r.vrfVk.buffer, r.vrfProof.buffer, r.vrfInput.buffer]),
            KesSum6Verify: (r) => collectBuffers([r.signature.buffer, r.publicKey.buffer, r.message.buffer]),
            Ed25519Verify: (r) => collectBuffers([r.message.buffer, r.signature.buffer, r.publicKey.buffer]),
            VrfProofToHash: (r) => collectBuffers([r.vrfProof.buffer]),
            CheckVrfLeader: () => [],
          });

          yield* worker.send(request, transfers);
          return yield* Deferred.await(result);
        }),
      );

    return { dispatch };
  }),
);

/**
 * Convenience: CryptoWorkerPool with platform + spawner layers provided.
 * The spawn function determines the worker entry point URL.
 *
 * For Bun: `BunWorker.layer(spawn)` provides WorkerPlatform + Spawner.
 * For browser: `BrowserWorker.layer(spawn)` does the same.
 */
export const CryptoWorkerPoolWithSpawner = (
  workerLayer: Layer.Layer<Worker.WorkerPlatform | Worker.Spawner>,
): Layer.Layer<CryptoWorkerPool> =>
  CryptoWorkerPoolLive.pipe(Layer.provide(workerLayer));
