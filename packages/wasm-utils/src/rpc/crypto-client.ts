import * as BunWorker from "@effect/platform-bun/BunWorker";
import { Context, Effect, Layer } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import type { WorkerError } from "effect/unstable/workers/WorkerError";

import { Crypto } from "../service.ts";

import { CryptoRpcGroup } from "./crypto-rpc.ts";

const WORKER_URL = new URL("./crypto-worker.ts", import.meta.url);

/**
 * RpcClient service for the Crypto RPC group. Resolved from a worker pool
 * (see `CryptoWorkerBun`).
 */
export class CryptoRpcClient extends Context.Service<
  CryptoRpcClient,
  RpcClient.RpcClient<RpcGroup.Rpcs<typeof CryptoRpcGroup>, RpcClientError>
>()("wasm-utils/CryptoRpcClient") {
  static readonly layer = Layer.effect(CryptoRpcClient)(RpcClient.make(CryptoRpcGroup));
}

/**
 * Crypto service layer backed by a Bun Worker pool. Method signatures
 * match `CryptoDirect` — call sites stay identical; only the Layer
 * provided at the entrypoint changes.
 */
const CryptoFromRpc: Layer.Layer<Crypto, never, CryptoRpcClient> = Layer.effect(
  Crypto,
  Effect.gen(function* () {
    const client = yield* CryptoRpcClient;
    return {
      blake2b256: (data) =>
        client.Blake2b256({ data }).pipe(Effect.mapError((err) => err as never)),
      ed25519Verify: (message, signature, publicKey) =>
        client.Ed25519Verify({ message, signature, publicKey }).pipe(
          Effect.mapError((err) => err as never),
        ),
      kesSum6Verify: (signature, period, publicKey, message) =>
        client.KesSum6Verify({ message, period, publicKey, signature }).pipe(
          Effect.mapError((err) => err as never),
        ),
      checkVrfLeader: (
        vrfOutputHex,
        sigmaNumerator,
        sigmaDenominator,
        activeSlotCoeffNum,
        activeSlotCoeffDen,
      ) =>
        client
          .CheckVrfLeader({
            activeSlotCoeffDen,
            activeSlotCoeffNum,
            sigmaDenominator,
            sigmaNumerator,
            vrfOutputHex,
          })
          .pipe(Effect.mapError((err) => err as never)),
      vrfVerifyProof: (vrfVkey, vrfProof, vrfInput) =>
        client.VrfVerifyProof({ vrfInput, vrfProof, vrfVkey }).pipe(
          Effect.mapError((err) => err as never),
        ),
      vrfProofToHash: (vrfProof) =>
        client.VrfProofToHash({ vrfProof }).pipe(Effect.mapError((err) => err as never)),
    };
  }),
);

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
 * const AppLive = Layer.mergeAll(
 *   CryptoWorkerBun,
 *   // ...
 * )
 * ```
 */
export const CryptoWorkerBun: Layer.Layer<Crypto, WorkerError> = CryptoFromRpc.pipe(
  Layer.provide(CryptoRpcClient.layer),
  Layer.provide(RpcClient.layerProtocolWorker({ size: workerPoolSize })),
  Layer.provide(RpcSerialization.layerMsgPack),
  Layer.provide(BunWorker.layer(() => new globalThis.Worker(WORKER_URL))),
);
