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
import { concat } from "codecs";
import { MultiEraBlock, decodeMultiEraBlock } from "ledger/lib/block/block.ts";
import { Era } from "ledger/lib/core/era.ts";
import { Crypto, CryptoOpError, type CryptoOperation } from "wasm-utils";
import { ValidationError, type ValidationOperation } from "./validation-rpc-group.ts";

/**
 * Extract the one-line `Effect.mapError` pattern used by every blake2b-backed
 * `ValidationClient` method (`ComputeBodyHash`, `ComputeTxId`, etc.). Keeps
 * the message field carrying the underlying Cause's `.message` so upstream
 * diagnostics preserve the wasm-level error text.
 */
export const mapCryptoToValidation =
  (operation: ValidationOperation) =>
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
export const mapTransportToCrypto =
  (operation: CryptoOperation) =>
  (cause: { readonly message: string }): CryptoOpError =>
    new CryptoOpError({
      operation,
      kind: "Unknown",
      code: 0,
      message: `rpc transport: ${cause.message}`,
    });

/**
 * The four "local" `ValidationClient` ops that never go through the RPC /
 * worker boundary:
 *   - `computeBodyHash` + `computeTxId` — blake2b-256 over small inputs
 *     (per-call Worker IPC dominates the <0.5ms hash cost)
 *   - `blake2b256Tagged` — tag-byte + data hash, same rationale
 *   - `decodeBlockCbor` — pure CBOR decode through the in-process `codecs`
 *     + `ledger` stack (no WASM call)
 *
 * Both `ValidationDirectLayer` and `ValidationFromRpc` consume this factory
 * so they can't drift on the shared error-shape conventions. The primitive
 * crypto ops (`ed25519Verify` / `kesSum6Verify` / …) stay layer-specific
 * because their transport differs (direct → `crypto.X`, RPC → `client.X`).
 */
// Pre-allocated 256 single-byte `Uint8Array`s — the per-call hot path of
// `blake2b256Tagged` then becomes a constant-time array index + `concat`,
// no per-call `new Uint8Array(1)` allocation. Total module-level footprint
// is ~256 × (8-byte header + 1 byte payload) ≈ 2.3KiB, paid once.
const TAG_BYTE_CACHE: ReadonlyArray<Uint8Array> = Array.from(
  { length: 256 },
  (_, i) => new Uint8Array([i]),
);

export const makeLocalValidationOps = (crypto: Context.Service.Shape<typeof Crypto>) => ({
  computeBodyHash: (blockBodyCbor: Uint8Array) =>
    crypto
      .blake2b256(blockBodyCbor)
      .pipe(Effect.mapError(mapCryptoToValidation("ComputeBodyHash"))),
  computeTxId: (txBodyCbor: Uint8Array) =>
    crypto.blake2b256(txBodyCbor).pipe(Effect.mapError(mapCryptoToValidation("ComputeTxId"))),
  blake2b256Tagged: (tag: number, data: Uint8Array) =>
    crypto.blake2b256(
      // `?? new Uint8Array([...])` is unreachable (the cache covers every
      // `tag & 0xff`) but satisfies `noUncheckedIndexedAccess`.
      concat(TAG_BYTE_CACHE[tag & 0xff] ?? new Uint8Array([tag & 0xff]), data),
    ),
  decodeBlockCbor: (blockCbor: Uint8Array) =>
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
    readonly vrfProofToHash: (vrfProof: Uint8Array) => Effect.Effect<Uint8Array, CryptoOpError>;
    readonly blake2b256Tagged: (
      tag: number,
      data: Uint8Array,
    ) => Effect.Effect<Uint8Array, CryptoOpError>;
  }
>()("consensus/ValidationClient") {}
