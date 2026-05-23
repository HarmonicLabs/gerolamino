/**
 * ValidationRpcGroup — 12-method RPC contract for CPU-bound short-lease
 * validation ops. Dispatched by consensus stages (header validate, body
 * validate, block-fetch body hash + tx-id batch) into a Pool<Worker>
 * running WASM crypto + pure CBOR decoders.
 *
 * The 6 crypto primitives extend the plan's per-primitive cost model
 * (per plan Tier-1 §11 catalog): inputs use structured-clone `BytesIn`;
 * success-channel hashes/outputs use `BytesOut` (`Transferable.schema`)
 * for zero-copy worker hand-off.
 *
 * The 6 consensus-level methods (ValidateHeader, ValidateBlockBody,
 * ComputeBodyHash, ComputeTxId, DecodeHeaderCbor, DecodeBlockCbor)
 * delegate to wasm-utils `Crypto` + `codecs` + `ledger` in the direct
 * layer; the worker layer re-runs them in-Worker using the same WASM
 * bindings (boot-once per worker, amortised across many calls).
 *
 * Per wave-2 Correction #2: Worker transport via
 * `RpcClient.layerProtocolWorker({ size, concurrency })` + a separate
 * `Worker.layerSpawner(fn)` layer. `spawn` is NOT an options field.
 */
import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as Transferable from "effect/unstable/workers/Transferable";
import { CryptoOpError } from "wasm-utils/errors.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Input bytes — plain `Schema.Uint8Array` (structured-clone copy).
 *
 * Never wrap inputs in `Transferable.schema`: the encoder registers
 * `[u.buffer]` in the postMessage transferList and detaches the caller's
 * ArrayBuffer — downstream code that reuses the buffer reads zeros.
 * See `wasm-utils/rpc/crypto-rpc.ts` + `reference_effect_rpc_transferable.md`.
 */
const BytesIn = Schema.Uint8Array;

/**
 * Output bytes — `Transferable.schema` on the success channel only.
 *
 * The worker has just produced fresh bytes and yields ownership to the
 * caller via the transferList; zero-copy is safe because the worker has
 * no further use for the buffer.
 */
const BytesOut = Transferable.schema(Schema.Uint8Array, (u) => [u.buffer]);

/** Enumerates every `ValidationClient` / `ValidationRpcGroup` op. Kept in
 * sync with the Rpc class declarations below; narrows `operation` from a
 * free-form string so `Match.value(e.operation)` exhaustively matches
 * every handler the group exposes. */
export const ValidationOperation = Schema.Literals([
  "ComputeBodyHash",
  "ComputeTxId",
  "DecodeBlockCbor",
  "Ed25519Verify",
  "KesSum6Verify",
  "CheckVrfLeader",
  "VrfVerify",
  "VrfProofToHash",
  "Blake2b256Tagged",
]);
export type ValidationOperation = typeof ValidationOperation.Type;

/** Validation-layer error — wraps primitive crypto + CBOR decode failures. */
export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()(
  "consensus/ValidationError",
  {
    operation: ValidationOperation,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

// ValidatedHeader / ValidatedBlockBody schemas were removed along with
// the 3 stub consensus-level Rpcs (ValidateHeader, ValidateBlockBody,
// DecodeHeaderCbor) in the wave-3 F7 pruning — they have no consumers
// anywhere in the monorepo now.

// ---------------------------------------------------------------------------
// Primitive-crypto RPCs (6 methods)
// ---------------------------------------------------------------------------

export class Ed25519Verify extends Rpc.make("Ed25519Verify", {
  payload: { message: BytesIn, signature: BytesIn, publicKey: BytesIn },
  success: Schema.Boolean,
  error: CryptoOpError,
}) {}

export class KesSum6Verify extends Rpc.make("KesSum6Verify", {
  payload: { signature: BytesIn, period: Schema.Number, publicKey: BytesIn, message: BytesIn },
  success: Schema.Boolean,
  error: CryptoOpError,
}) {}

export class CheckVrfLeader extends Rpc.make("CheckVrfLeader", {
  payload: {
    vrfOutputHex: Schema.String,
    sigmaNumerator: Schema.String,
    sigmaDenominator: Schema.String,
    activeSlotCoeffNum: Schema.String,
    activeSlotCoeffDen: Schema.String,
  },
  success: Schema.Boolean,
  error: CryptoOpError,
}) {}

export class VrfVerify extends Rpc.make("VrfVerify", {
  payload: { vrfVkey: BytesIn, vrfProof: BytesIn, vrfInput: BytesIn },
  success: BytesOut,
  error: CryptoOpError,
}) {}

export class VrfProofToHash extends Rpc.make("VrfProofToHash", {
  payload: { vrfProof: BytesIn },
  success: BytesOut,
  error: CryptoOpError,
}) {}

/**
 * Blake2b-256 with a prefix byte tag, per Praos VRF output derivation
 * (`0x4c` leader, `0x4e` nonce — see wave-2 Correction #20 for ASCII
 * origin: `'L'`, `'N'` in upstream Haskell).
 */
export class Blake2b256Tagged extends Rpc.make("Blake2b256Tagged", {
  payload: { tag: Schema.Number, data: BytesIn },
  success: BytesOut,
  error: CryptoOpError,
}) {}

// ---------------------------------------------------------------------------
// Consensus-level RPCs (3 methods)
//
// The higher-level validators (`ValidateHeader`, `ValidateBlockBody`,
// `DecodeHeaderCbor`) are implemented inline in consensus today; forwarding
// them through this RPC surface would ship raw CBOR across the worker
// boundary for a call that is *already* CPU-bound in the caller's fiber
// via the consensus stage pipeline. They'll land here once the SyncStage
// pipeline offloads them to a worker. Until then, carrying them as
// stub-backed Rpcs lied at the type level about what the service could
// do; every consumer had to know which methods worked and which raised
// `validationNotImplemented`.
//
// `ComputeBodyHash`, `ComputeTxId`, `DecodeBlockCbor` stay — they are the
// short-lease primitives downstream block-fetch code actually dispatches.
// ---------------------------------------------------------------------------

/** Compute the body hash (blake2b-256 of concatenated body sections). */
export class ComputeBodyHash extends Rpc.make("ComputeBodyHash", {
  payload: { blockBodyCbor: BytesIn },
  success: BytesOut,
  error: ValidationError,
}) {}

/** Compute the tx-id (blake2b-256 of tx body CBOR). */
export class ComputeTxId extends Rpc.make("ComputeTxId", {
  payload: { txBodyCbor: BytesIn },
  success: BytesOut,
  error: ValidationError,
}) {}

/** Decode a full block CBOR into `MultiEraBlock` summary. */
export class DecodeBlockCbor extends Rpc.make("DecodeBlockCbor", {
  payload: { blockCbor: BytesIn },
  success: Schema.Struct({
    eraVariant: Schema.Number,
    slot: Schema.BigInt,
    blockNo: Schema.BigInt,
    hash: BytesOut,
  }),
  error: ValidationError,
}) {}

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const ValidationRpcGroup = RpcGroup.make(
  // Consensus-level ops
  ComputeBodyHash,
  ComputeTxId,
  DecodeBlockCbor,
  // Primitive-crypto ops
  Ed25519Verify,
  KesSum6Verify,
  CheckVrfLeader,
  VrfVerify,
  VrfProofToHash,
  Blake2b256Tagged,
);
