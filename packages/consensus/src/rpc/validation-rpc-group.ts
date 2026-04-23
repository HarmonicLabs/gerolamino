/**
 * ValidationRpcGroup — 12-method RPC contract for CPU-bound short-lease
 * validation ops. Dispatched by consensus stages (header validate, body
 * validate, block-fetch body hash + tx-id batch) into a Pool<Worker>
 * running WASM crypto + pure CBOR decoders.
 *
 * The 6 crypto primitives extend the plan's per-primitive cost model
 * (per plan Tier-1 §11 catalog): each Rpc ships zero-copy Uint8Array
 * payloads via `Transferable.schema`, with `detach-on-send` semantics
 * handled by per-call buffer factories at the caller side.
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
import { CryptoOpError } from "wasm-utils";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Zero-copy byte schema. Wraps `Schema.Uint8Array` via
 * `Transferable.schema` — the underlying ArrayBuffer is registered in the
 * postMessage transfer list, so workers get the buffer without copying.
 *
 * Runtime detach caveat (wave-2 Correction #29): once transferred, the
 * sender's ArrayBuffer is detached. Per-call buffer factories on the
 * caller side are required; never share module-level constants.
 */
const Bytes = Transferable.schema(Schema.Uint8Array, (u) => [u.buffer]);

/** Validation-layer error — wraps primitive crypto + CBOR decode failures. */
export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()(
  "consensus/ValidationError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** Header-specific validation outcome — carries `hash` for downstream caching. */
export const ValidatedHeader = Schema.Struct({
  slot: Schema.BigInt,
  blockNo: Schema.BigInt,
  hash: Bytes,
});
export type ValidatedHeader = typeof ValidatedHeader.Type;

/** Body-validation outcome — `bodyHash` + per-tx ids. */
export const ValidatedBlockBody = Schema.Struct({
  bodyHash: Bytes,
  txIds: Schema.Array(Bytes),
});
export type ValidatedBlockBody = typeof ValidatedBlockBody.Type;

// ---------------------------------------------------------------------------
// Primitive-crypto RPCs (6 methods)
// ---------------------------------------------------------------------------

export class Ed25519Verify extends Rpc.make("Ed25519Verify", {
  payload: { message: Bytes, signature: Bytes, publicKey: Bytes },
  success: Schema.Boolean,
  error: CryptoOpError,
}) {}

export class KesSum6Verify extends Rpc.make("KesSum6Verify", {
  payload: { signature: Bytes, period: Schema.Number, publicKey: Bytes, message: Bytes },
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
  payload: { vrfVkey: Bytes, vrfProof: Bytes, vrfInput: Bytes },
  success: Bytes,
  error: CryptoOpError,
}) {}

export class VrfProofToHash extends Rpc.make("VrfProofToHash", {
  payload: { vrfProof: Bytes },
  success: Bytes,
  error: CryptoOpError,
}) {}

/**
 * Blake2b-256 with a prefix byte tag, per Praos VRF output derivation
 * (`0x4c` leader, `0x4e` nonce — see wave-2 Correction #20 for ASCII
 * origin: `'L'`, `'N'` in upstream Haskell).
 */
export class Blake2b256Tagged extends Rpc.make("Blake2b256Tagged", {
  payload: { tag: Schema.Number, data: Bytes },
  success: Bytes,
  error: CryptoOpError,
}) {}

// ---------------------------------------------------------------------------
// Consensus-level RPCs (6 methods)
// ---------------------------------------------------------------------------

/**
 * Validate a Praos block header. Returns a lightweight `ValidatedHeader`
 * summary for downstream caching (so callers don't re-decode the CBOR).
 * Failures carry the first-caught predicate per the plan's `validate`
 * mode on `Effect.all`.
 */
export class ValidateHeader extends Rpc.make("ValidateHeader", {
  payload: { headerCbor: Bytes, eraVariant: Schema.Number },
  success: ValidatedHeader,
  error: ValidationError,
}) {}

/**
 * Validate a block body (body hash + per-tx ids). Independent from
 * header validation; dispatched after header passes.
 */
export class ValidateBlockBody extends Rpc.make("ValidateBlockBody", {
  payload: { blockCbor: Bytes, eraVariant: Schema.Number },
  success: ValidatedBlockBody,
  error: ValidationError,
}) {}

/** Compute the body hash (blake2b-256 of concatenated body sections). */
export class ComputeBodyHash extends Rpc.make("ComputeBodyHash", {
  payload: { blockBodyCbor: Bytes },
  success: Bytes,
  error: ValidationError,
}) {}

/** Compute the tx-id (blake2b-256 of tx body CBOR). */
export class ComputeTxId extends Rpc.make("ComputeTxId", {
  payload: { txBodyCbor: Bytes },
  success: Bytes,
  error: ValidationError,
}) {}

/** Decode a block header CBOR into the typed consensus `BlockHeader` shape. */
export class DecodeHeaderCbor extends Rpc.make("DecodeHeaderCbor", {
  payload: { headerCbor: Bytes, eraVariant: Schema.Number },
  success: ValidatedHeader,
  error: ValidationError,
}) {}

/** Decode a full block CBOR into `MultiEraBlock` summary. */
export class DecodeBlockCbor extends Rpc.make("DecodeBlockCbor", {
  payload: { blockCbor: Bytes },
  success: Schema.Struct({
    eraVariant: Schema.Number,
    slot: Schema.BigInt,
    blockNo: Schema.BigInt,
    hash: Bytes,
  }),
  error: ValidationError,
}) {}

// ---------------------------------------------------------------------------
// Group
// ---------------------------------------------------------------------------

export const ValidationRpcGroup = RpcGroup.make(
  // Consensus-level ops
  ValidateHeader,
  ValidateBlockBody,
  ComputeBodyHash,
  ComputeTxId,
  DecodeHeaderCbor,
  DecodeBlockCbor,
  // Primitive-crypto ops
  Ed25519Verify,
  KesSum6Verify,
  CheckVrfLeader,
  VrfVerify,
  VrfProofToHash,
  Blake2b256Tagged,
);
