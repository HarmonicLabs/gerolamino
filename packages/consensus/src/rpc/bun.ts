/**
 * Bun-specific subpath for `ValidationClient` + `NodeRpcGroup` Worker transports.
 *
 * Import from `"consensus/rpc/bun.ts"` ONLY in Bun entrypoints (apps/tui
 * main.ts, apps/bootstrap cli.ts). The default `consensus/rpc` barrel
 * deliberately does NOT re-export these — `@effect/platform-bun/BunWorker`
 * pulls Bun-native modules that break a browser bundle at resolve time, even
 * with tree-shaking.
 *
 * Browser consumers should either:
 *   - bind `ValidationClient` via `ValidationDirectLayer` (in-process WASM,
 *     no Worker), or
 *   - add a sibling `./browser.ts` module that spawns `BrowserWorker.layer`
 *     from `@effect/platform-browser` (deferred, plan Phase 5 chrome-ext wave).
 */
import * as BunWorker from "@effect/platform-bun/BunWorker";
import { Config, Effect, Layer } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import type { WorkerError } from "effect/unstable/workers/WorkerError";
import { type Crypto } from "wasm-utils";

import type { ValidationClient } from "./validation-client.ts";
import { ValidationFromRpc, ValidationRpcClient } from "./validation-rpc-client.ts";

const WORKER_URL = new URL("./validation-worker.ts", import.meta.url);

/**
 * Pool sizing — operator-overridable via `VALIDATION_WORKERS` env. Default
 * reserves 1 core for the calling Node Worker's main fiber on > 2-core
 * hosts; pins to 2 on smaller hosts so CI / tiny VMs still get a working
 * pool.
 */
const workerPoolSize = Effect.gen(function* () {
  return yield* Config.number("VALIDATION_WORKERS").pipe(
    Config.withDefault(Math.max(2, (navigator.hardwareConcurrency ?? 2) - 1)),
  );
}).pipe(Effect.orDie);

/**
 * `ValidationClient` backed by a Bun Worker pool + RPC transport. Compose
 * at the app entrypoint — swap `ValidationDirectLayer` for this to move
 * crypto off the main fiber. Caller must still provide `Crypto`
 * (`CryptoDirect` or `CryptoWorkerBun` from wasm-utils) because the
 * caller-side blake2b + decode shortcuts run in-process here.
 */
export const ValidationWorkerBun: Layer.Layer<ValidationClient, WorkerError, Crypto> = Layer.unwrap(
  workerPoolSize.pipe(
    Effect.map((size) =>
      ValidationFromRpc.pipe(
        Layer.provide(ValidationRpcClient.layer),
        Layer.provide(RpcClient.layerProtocolWorker({ size, concurrency: 16 })),
        Layer.provide(RpcSerialization.layerMsgPack),
        Layer.provide(BunWorker.layer(() => new globalThis.Worker(WORKER_URL))),
      ),
    ),
  ),
);

export { ValidationRpcClient } from "./validation-rpc-client.ts";

// `ConsensusEngineWithWorkerCrypto` was removed along with the
// `ConsensusEngine` service — consumers now compose `CryptoWorkerBun`
// (from `wasm-utils/rpc/bun.ts`) with their own layer stack and call
// `validateHeader` directly. Example:
//   const app = Layer.mergeAll(CryptoWorkerBun, slotClockLayer, peerManagerLayer, ...)
