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
import { concat } from "codecs";
import { Crypto } from "wasm-utils";
import { MultiEraBlock, decodeMultiEraBlock } from "ledger/lib/block/block.ts";
import { Era } from "ledger/lib/core/era.ts";

import {
  ValidationClient,
  mapCryptoToValidation,
  mapTransportToCrypto,
} from "./validation-client.ts";
import { ValidationError, ValidationRpcGroup } from "./validation-rpc-group.ts";
import type { CryptoOpError } from "wasm-utils";

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

      return ValidationClient.of({
        computeBodyHash: (blockBodyCbor) =>
          crypto
            .blake2b256(blockBodyCbor)
            .pipe(Effect.mapError(mapCryptoToValidation("ComputeBodyHash"))),
        computeTxId: (txBodyCbor) =>
          crypto.blake2b256(txBodyCbor).pipe(Effect.mapError(mapCryptoToValidation("ComputeTxId"))),
        blake2b256Tagged: (tag, data) =>
          crypto.blake2b256(concat(new Uint8Array([tag & 0xff]), data)),

        decodeBlockCbor: (blockCbor) =>
          decodeMultiEraBlock(blockCbor).pipe(
            Effect.map((block) =>
              MultiEraBlock.match(block, {
                byron: () => ({
                  eraVariant: Era.Byron,
                  slot: 0n,
                  blockNo: 0n,
                  hash: new Uint8Array(32),
                }),
                postByron: ({ era, header }) => ({
                  eraVariant: era,
                  slot: header.slot,
                  blockNo: header.blockNo,
                  hash: new Uint8Array(32),
                }),
              }),
            ),
            Effect.mapError(
              (issue) =>
                new ValidationError({
                  operation: "DecodeBlockCbor",
                  message: issue._tag ?? "Decode failed",
                  cause: issue,
                }),
            ),
          ),

        // Worker-dispatched crypto primitives. The RPC error channel is
        // `CryptoOpError | RpcClientError`: domain failures already surface
        // as `CryptoOpError` from the handler; only `RpcClientError`
        // (transport — worker crash, framing failure, serialization) needs
        // narrowing. `Effect.catchTag("RpcClientError", ...)` maps it to a
        // synthetic `CryptoOpError` so the service signature stays tight.
        ed25519Verify: (message, signature, publicKey) =>
          client
            .Ed25519Verify({ message, signature, publicKey })
            .pipe(
              Effect.catchTag("RpcClientError", (err) =>
                Effect.fail<CryptoOpError>(mapTransportToCrypto("ed25519Verify")(err)),
              ),
            ),
        kesSum6Verify: (signature, period, publicKey, message) =>
          client
            .KesSum6Verify({ message, period, publicKey, signature })
            .pipe(
              Effect.catchTag("RpcClientError", (err) =>
                Effect.fail<CryptoOpError>(mapTransportToCrypto("kesSum6Verify")(err)),
              ),
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
            .pipe(
              Effect.catchTag("RpcClientError", (err) =>
                Effect.fail<CryptoOpError>(mapTransportToCrypto("checkVrfLeader")(err)),
              ),
            ),
        vrfVerify: (vrfVkey, vrfProof, vrfInput) =>
          client
            .VrfVerify({ vrfInput, vrfProof, vrfVkey })
            .pipe(
              Effect.catchTag("RpcClientError", (err) =>
                Effect.fail<CryptoOpError>(mapTransportToCrypto("vrfVerifyProof")(err)),
              ),
            ),
        vrfProofToHash: (vrfProof) =>
          client
            .VrfProofToHash({ vrfProof })
            .pipe(
              Effect.catchTag("RpcClientError", (err) =>
                Effect.fail<CryptoOpError>(mapTransportToCrypto("vrfProofToHash")(err)),
              ),
            ),
      });
    }),
  );
