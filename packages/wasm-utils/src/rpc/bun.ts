/**
 * Bun-specific subpath for the Crypto RPC Worker pool.
 *
 * Import from `"wasm-utils/rpc/bun.ts"` ONLY in Bun entrypoints
 * (apps/tui main.ts, apps/bootstrap cli.ts, anything running on
 * `@effect/platform-bun`). The default `wasm-utils/rpc` barrel deliberately
 * does NOT re-export this — `@effect/platform-bun/BunWorker` pulls
 * Bun-native modules (`bun:ffi`, `node:*`) that break a browser bundle at
 * resolve time, even with tree-shaking.
 *
 * Browser consumers should either:
 *   - bind `Crypto` via `CryptoDirect` (in-process WASM, no Worker), or
 *   - add a sibling `./browser.ts` module that spawns `BrowserWorker.layer`
 *     from `@effect/platform-browser` (deferred, plan Phase 5).
 */
import * as BunWorker from "@effect/platform-bun/BunWorker";
import { Layer } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import type { WorkerError } from "effect/unstable/workers/WorkerError";

import type { Crypto } from "../service.ts";
import { CryptoFromRpc, CryptoRpcClient } from "./crypto-client.ts";

const cryptoWorkerUrl = new URL("./crypto-worker.ts", import.meta.url);

/**
 * Single shared worker pool sized to the host's CPU core count.
 * `navigator.hardwareConcurrency` is available in Bun ≥1.1, Node.js ≥21,
 * and every browser per the WHATWG HTML spec; fall back to 1 if missing.
 */
const workerPoolSize = navigator.hardwareConcurrency ?? 1;

/**
 * `Crypto` service backed by Bun Workers + RPC. One shared pool for the
 * entire blockchain — compose once at the entrypoint:
 *
 * ```ts
 * import { CryptoWorkerBun } from "wasm-utils/rpc/bun.ts"
 * const AppLive = Layer.mergeAll(CryptoWorkerBun, ...)
 * ```
 */
export const CryptoWorkerBun: Layer.Layer<Crypto, WorkerError> = CryptoFromRpc.pipe(
  Layer.provide(CryptoRpcClient.layer),
  Layer.provide(RpcClient.layerProtocolWorker({ size: workerPoolSize })),
  Layer.provide(RpcSerialization.layerMsgPack),
  Layer.provide(BunWorker.layer(() => new globalThis.Worker(cryptoWorkerUrl))),
);

export { CryptoRpcClient } from "./crypto-client.ts";
