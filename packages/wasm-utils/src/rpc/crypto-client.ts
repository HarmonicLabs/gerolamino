import { Context, Effect, Layer } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { CryptoOpError, type CryptoOperation } from "../errors.ts";
import { Crypto } from "../service.ts";

import { CryptoRpcGroup } from "./crypto-rpc.ts";

/**
 * RpcClient service for the Crypto RPC group. Resolved from a worker pool
 * (see the Bun-specific `./bun.ts` subpath, or a future `./browser.ts`).
 *
 * The class + `CryptoFromRpc` layer stay here because they are
 * platform-agnostic — both browser and Bun consumers bind the same
 * `RpcClient<CryptoRpcGroup>` service. Platform-specific spawners live in
 * their own module so the default barrel stays browser-safe.
 */
export class CryptoRpcClient extends Context.Service<
  CryptoRpcClient,
  RpcClient.RpcClient<RpcGroup.Rpcs<typeof CryptoRpcGroup>, RpcClientError>
>()("wasm-utils/CryptoRpcClient") {
  static readonly layer = Layer.effect(CryptoRpcClient)(RpcClient.make(CryptoRpcGroup));
}

/**
 * Convert a worker-transport `RpcClientError` into a `CryptoOpError` so the
 * `Crypto` service signature stays `Effect<_, CryptoOpError>` whether the
 * layer is direct or worker-backed. The alternative — widening the service
 * error channel to `CryptoOpError | RpcClientError` — would ripple through
 * every consensus caller for a failure shape they can't meaningfully
 * differentiate from an in-process WASM error anyway.
 */
const mapTransportError = (operation: CryptoOperation) => (err: RpcClientError) =>
  new CryptoOpError({
    operation,
    kind: "Unknown",
    code: 0,
    message: `rpc transport: ${err.message}`,
  });

/**
 * `Crypto` service implementation that forwards every call through the
 * RPC client. Method signatures match `CryptoDirect` — call sites stay
 * identical; only the Layer provided at the entrypoint changes.
 *
 * The RpcClient error channel carries `CryptoOpError | RpcClientError`;
 * domain errors already surface as `CryptoOpError` from the handler side,
 * so only the transport-failure arm needs mapping. `Effect.catchTag` on
 * `RpcClientError` narrows the channel back to the service's declared
 * `CryptoOpError` without casting.
 */
export const CryptoFromRpc: Layer.Layer<Crypto, never, CryptoRpcClient> = Layer.effect(
  Crypto,
  Effect.gen(function* () {
    const client = yield* CryptoRpcClient;
    const catchTransport = <A>(
      operation: CryptoOperation,
      eff: Effect.Effect<A, CryptoOpError | RpcClientError>,
    ): Effect.Effect<A, CryptoOpError> =>
      eff.pipe(Effect.catchTag("RpcClientError", (err) => Effect.fail(mapTransportError(operation)(err))));

    return {
      blake2b256: (data) => catchTransport("blake2b256", client.Blake2b256({ data })),
      ed25519Verify: (message, signature, publicKey) =>
        catchTransport("ed25519Verify", client.Ed25519Verify({ message, signature, publicKey })),
      kesSum6Verify: (signature, period, publicKey, message) =>
        catchTransport(
          "kesSum6Verify",
          client.KesSum6Verify({ message, period, publicKey, signature }),
        ),
      checkVrfLeader: (
        vrfOutputHex,
        sigmaNumerator,
        sigmaDenominator,
        activeSlotCoeffNum,
        activeSlotCoeffDen,
      ) =>
        catchTransport(
          "checkVrfLeader",
          client.CheckVrfLeader({
            activeSlotCoeffDen,
            activeSlotCoeffNum,
            sigmaDenominator,
            sigmaNumerator,
            vrfOutputHex,
          }),
        ),
      vrfVerifyProof: (vrfVkey, vrfProof, vrfInput) =>
        catchTransport(
          "vrfVerifyProof",
          client.VrfVerifyProof({ vrfInput, vrfProof, vrfVkey }),
        ),
      vrfProofToHash: (vrfProof) =>
        catchTransport("vrfProofToHash", client.VrfProofToHash({ vrfProof })),
    };
  }),
);

// The Bun-Worker entrypoint URL lives in `./bun.ts` alongside the spawner.
// Keeping `new URL("./crypto-worker.ts", import.meta.url)` out of this module
// prevents browser bundlers from traversing the Worker entrypoint and
// picking up its `@effect/platform-bun` imports as transitive deps.
