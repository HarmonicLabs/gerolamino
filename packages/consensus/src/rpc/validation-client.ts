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
import type { CryptoOpError } from "wasm-utils";
import type { ValidatedBlockBody, ValidatedHeader, ValidationError } from "./validation-rpc-group.ts";

/**
 * The 12-method validation interface. Methods fall into two buckets per
 * plan Tier-1 §11:
 *   - 6 consensus-level ops (ValidateHeader, ValidateBlockBody,
 *     ComputeBodyHash, ComputeTxId, DecodeHeaderCbor, DecodeBlockCbor)
 *   - 6 primitive crypto ops (Ed25519Verify, KesSum6Verify,
 *     CheckVrfLeader, VrfVerify, VrfProofToHash, Blake2b256Tagged)
 *
 * All short-lease (<2ms median). The worker layer multiplexes many
 * in-flight calls per Worker via auto-tracked request IDs so a single
 * call doesn't waste a whole Worker.
 */
export class ValidationClient extends Context.Service<
  ValidationClient,
  {
    // Consensus-level
    readonly validateHeader: (
      headerCbor: Uint8Array,
      eraVariant: number,
    ) => Effect.Effect<ValidatedHeader, ValidationError>;
    readonly validateBlockBody: (
      blockCbor: Uint8Array,
      eraVariant: number,
    ) => Effect.Effect<ValidatedBlockBody, ValidationError>;
    readonly computeBodyHash: (
      blockBodyCbor: Uint8Array,
    ) => Effect.Effect<Uint8Array, ValidationError>;
    readonly computeTxId: (txBodyCbor: Uint8Array) => Effect.Effect<Uint8Array, ValidationError>;
    readonly decodeHeaderCbor: (
      headerCbor: Uint8Array,
      eraVariant: number,
    ) => Effect.Effect<ValidatedHeader, ValidationError>;
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
