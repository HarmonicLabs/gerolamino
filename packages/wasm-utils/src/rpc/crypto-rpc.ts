import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as Transferable from "effect/unstable/workers/Transferable";

import { CryptoOpError } from "../errors.ts";

/**
 * Input bytes for crypto RPC payloads — plain `Schema.Uint8Array`.
 *
 * The structured-clone path (no transferList) makes the Worker receive
 * a fresh copy while the caller's buffer stays intact and live. Wrapping
 * inputs in `Transferable.schema` is wrong here: the encoder appends
 * `[u.buffer]` to the postMessage transferList, which detaches the
 * caller's underlying `ArrayBuffer` on `postMessage`. The caller's
 * `Uint8Array` view stays the same length but reads as all zeros — a
 * subtle, painful failure mode where any code that reuses the buffer
 * after the crypto call (e.g. the header bridge running blake2b256 then
 * walking the CBOR for `extractFirstArrayItemBytes`) sees garbage.
 *
 * We pay one structured-clone copy per call (~µs for typical header /
 * block-body sizes) and gain durable buffer ownership.
 */
const BytesIn = Schema.Uint8Array;

/**
 * Output bytes for crypto RPC payloads — `Transferable.schema`.
 *
 * Used only on the success channel: the Worker has just produced fresh
 * bytes (a hash, a VRF output) and yields ownership to the main thread
 * via the transferList — zero-copy is safe because the Worker has no
 * further use for the buffer.
 */
const BytesOut = Transferable.schema(Schema.Uint8Array, (u) => [u.buffer]);

export class Ed25519Verify extends Rpc.make("Ed25519Verify", {
  payload: {
    message: BytesIn,
    signature: BytesIn,
    publicKey: BytesIn,
  },
  success: Schema.Boolean,
  error: CryptoOpError,
}) {}

export class KesSum6Verify extends Rpc.make("KesSum6Verify", {
  payload: {
    signature: BytesIn,
    period: Schema.Number,
    publicKey: BytesIn,
    message: BytesIn,
  },
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

export class VrfVerifyProof extends Rpc.make("VrfVerifyProof", {
  payload: {
    vrfVkey: BytesIn,
    vrfProof: BytesIn,
    vrfInput: BytesIn,
  },
  success: BytesOut,
  error: CryptoOpError,
}) {}

export class VrfProofToHash extends Rpc.make("VrfProofToHash", {
  payload: { vrfProof: BytesIn },
  success: BytesOut,
  error: CryptoOpError,
}) {}

export class Blake2b256 extends Rpc.make("Blake2b256", {
  payload: { data: BytesIn },
  success: BytesOut,
  error: CryptoOpError,
}) {}

export const CryptoRpcGroup = RpcGroup.make(
  Ed25519Verify,
  KesSum6Verify,
  CheckVrfLeader,
  VrfVerifyProof,
  VrfProofToHash,
  Blake2b256,
);
