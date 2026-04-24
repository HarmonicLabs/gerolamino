/**
 * ValidationClient — consumer-facing service tag with the 12-method
 * validation interface. Two implementations (swapped at app entrypoint):
 *   - `ValidationDirect.layer` — in-process, handlers run in the caller's
 *     fiber (backed by `Crypto` from wasm-utils)
 *   - `ValidationWorker.layerBun` — dispatch through a Pool<Worker> via
 *     `RpcClient.layerProtocolWorker` + `Worker.layerSpawner`
 *
 * Mirrors the `Crypto` + `CryptoDirect` / `CryptoWorkerBun` pattern in
 * wasm-utils: same service shape, different Layer — consumers import
 * `ValidationClient` and never know which transport is under the hood.
 */
import { Context, Effect } from "effect";
import { CryptoOpError, type CryptoOperation } from "wasm-utils";
import { ValidationError, type ValidationOperation } from "./validation-rpc-group.ts";

/**
 * Extract the one-line `Effect.mapError` pattern used by every blake2b-backed
 * `ValidationClient` method (`ComputeBodyHash`, `ComputeTxId`, etc.). Keeps
 * the message field carrying the underlying Cause's `.message` so upstream
 * diagnostics preserve the wasm-level error text.
 */
export const mapCryptoToValidation = (operation: ValidationOperation) =>
  (cause: CryptoOpError): ValidationError =>
    new ValidationError({ operation, message: cause.message, cause });

/**
 * Convert a worker-transport `RpcClientError` shape (message string field
 * available regardless of the specific transport subtype) into a
 * `CryptoOpError` so the crypto primitive methods' declared error channel
 * (`CryptoOpError`) stays tight when routed through the RPC layer.
 *
 * Alternative — widening `ValidationClient`'s crypto methods to
 * `CryptoOpError | RpcClientError` — would leak the transport choice across
 * every consensus caller, even callers using `ValidationDirectLayer` where
 * the transport error can't arise.
 */
export const mapTransportToCrypto = (operation: CryptoOperation) =>
  (cause: { readonly message: string }): CryptoOpError =>
    new CryptoOpError({
      operation,
      kind: "Unknown",
      code: 0,
      message: `rpc transport: ${cause.message}`,
    });

/**
 * The 9-method validation interface. Methods fall into two buckets per
 * plan Tier-1 §11:
 *   - 3 consensus-level ops (ComputeBodyHash, ComputeTxId, DecodeBlockCbor)
 *   - 6 primitive crypto ops (Ed25519Verify, KesSum6Verify,
 *     CheckVrfLeader, VrfVerify, VrfProofToHash, Blake2b256Tagged)
 *
 * The higher-level validators (ValidateHeader, ValidateBlockBody,
 * DecodeHeaderCbor) were removed from the service: carrying them as
 * stub-backed methods lied at the type level about which calls were
 * actually wired. They'll land when the SyncStage pipeline offloads
 * them to a worker.
 *
 * All short-lease (<2ms median). The worker layer multiplexes many
 * in-flight calls per Worker via auto-tracked request IDs so a single
 * call doesn't waste a whole Worker.
 */
export class ValidationClient extends Context.Service<
  ValidationClient,
  {
    // Consensus-level
    readonly computeBodyHash: (
      blockBodyCbor: Uint8Array,
    ) => Effect.Effect<Uint8Array, ValidationError>;
    readonly computeTxId: (txBodyCbor: Uint8Array) => Effect.Effect<Uint8Array, ValidationError>;
    readonly decodeBlockCbor: (blockCbor: Uint8Array) => Effect.Effect<
      {
        readonly eraVariant: number;
        readonly slot: bigint;
        readonly blockNo: bigint;
        readonly hash: Uint8Array;
      },
      ValidationError
    >;

    // Primitive crypto
    readonly ed25519Verify: (
      message: Uint8Array,
      signature: Uint8Array,
      publicKey: Uint8Array,
    ) => Effect.Effect<boolean, CryptoOpError>;
    readonly kesSum6Verify: (
      signature: Uint8Array,
      period: number,
      publicKey: Uint8Array,
      message: Uint8Array,
    ) => Effect.Effect<boolean, CryptoOpError>;
    readonly checkVrfLeader: (
      vrfOutputHex: string,
      sigmaNumerator: string,
      sigmaDenominator: string,
      activeSlotCoeffNum: string,
      activeSlotCoeffDen: string,
    ) => Effect.Effect<boolean, CryptoOpError>;
    readonly vrfVerify: (
      vrfVkey: Uint8Array,
      vrfProof: Uint8Array,
      vrfInput: Uint8Array,
    ) => Effect.Effect<Uint8Array, CryptoOpError>;
    readonly vrfProofToHash: (
      vrfProof: Uint8Array,
    ) => Effect.Effect<Uint8Array, CryptoOpError>;
    readonly blake2b256Tagged: (
      tag: number,
      data: Uint8Array,
    ) => Effect.Effect<Uint8Array, CryptoOpError>;
  }
>()("consensus/ValidationClient") {}
