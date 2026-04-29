/**
 * Abstract `ValidationClient` implementation that forwards consensus + crypto
 * ops over RPC to a worker pool. Keeps blake2b + `decodeBlockCbor` in the
 * caller's fiber — those go through the shared in-process `Crypto` service
 * (WASM) so this module stays browser-compatible and avoids a Worker
 * round-trip for small inputs.
 *
 * The RPC client's *transport* is platform-specific — `BunWorker` on Bun,
 * `BrowserWorker` in a chrome-ext offscreen doc, a WebSocket client for
 * remote dashboards, etc. Those live in subpaths (see `./bun.ts`); this
 * file only declares the client tag + the layer shape that every transport
 * composes into.
 */
import { Context, Effect, Layer } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { Crypto } from "wasm-utils";

import {
  ValidationClient,
  makeLocalValidationOps,
  mapTransportToCrypto,
} from "./validation-client.ts";
import { ValidationRpcGroup } from "./validation-rpc-group.ts";
import type { CryptoOpError, CryptoOperation } from "wasm-utils";

/**
 * RpcClient service tag for `ValidationRpcGroup`. Resolved from whatever
 * transport the app entrypoint provides; call sites read `ValidationClient`
 * and never touch this directly.
 */
export class ValidationRpcClient extends Context.Service<
  ValidationRpcClient,
  RpcClient.RpcClient<RpcGroup.Rpcs<typeof ValidationRpcGroup>, RpcClientError>
>()("consensus/ValidationRpcClient") {
  static readonly layer = Layer.effect(ValidationRpcClient)(RpcClient.make(ValidationRpcGroup));
}

/**
 * `ValidationClient` implementation that forwards worker-bound ops over
 * RPC and keeps small/local ops in-process. Caller must still provide
 * `Crypto` (`CryptoDirect` or a platform-specific worker Crypto layer)
 * because the caller-side blake2b + decode shortcuts run in-process here.
 */
export const ValidationFromRpc: Layer.Layer<ValidationClient, never, Crypto | ValidationRpcClient> =
  Layer.effect(
    ValidationClient,
    Effect.gen(function* () {
      const client = yield* ValidationRpcClient;
      const crypto = yield* Crypto;

      // Worker-dispatched crypto primitives share an error-channel shape:
      // `CryptoOpError | RpcClientError`. Domain failures already surface as
      // `CryptoOpError` from the handler; only `RpcClientError` (transport —
      // worker crash, framing failure, serialization) needs narrowing.
      // `catchTransport(method)` is the curried `Effect.catchTag` that maps
      // the transport error back into a synthetic `CryptoOpError` so every
      // RPC forwarder reads as `client.X(...).pipe(catchTransport("method"))`.
      const catchTransport =
        <A, R>(method: CryptoOperation) =>
        (
          effect: Effect.Effect<A, CryptoOpError | RpcClientError, R>,
        ): Effect.Effect<A, CryptoOpError, R> =>
          Effect.catchTag(effect, "RpcClientError", (err) =>
            Effect.fail<CryptoOpError>(mapTransportToCrypto(method)(err)),
          );

      return ValidationClient.of({
        // Consensus-level + tagged-blake ops are the same in both Direct
        // and RPC layers — sourced from the shared `makeLocalValidationOps`
        // so they can't drift on error-shape conventions.
        ...makeLocalValidationOps(crypto),

        // Primitive crypto — RPC-forwarded with `catchTransport` mapping
        // `RpcClientError → CryptoOpError` per method.
        ed25519Verify: (message, signature, publicKey) =>
          client
            .Ed25519Verify({ message, signature, publicKey })
            .pipe(catchTransport("ed25519Verify")),
        kesSum6Verify: (signature, period, publicKey, message) =>
          client
            .KesSum6Verify({ message, period, publicKey, signature })
            .pipe(catchTransport("kesSum6Verify")),
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
            .pipe(catchTransport("checkVrfLeader")),
        vrfVerify: (vrfVkey, vrfProof, vrfInput) =>
          client.VrfVerify({ vrfInput, vrfProof, vrfVkey }).pipe(catchTransport("vrfVerifyProof")),
        vrfProofToHash: (vrfProof) =>
          client.VrfProofToHash({ vrfProof }).pipe(catchTransport("vrfProofToHash")),
      });
    }),
  );
