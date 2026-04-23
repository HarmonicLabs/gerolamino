import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as Transferable from "effect/unstable/workers/Transferable";

import { CryptoOpError } from "../errors.ts";

/**
 * Zero-copy byte schema. Uses `Transferable.schema` wrapped around the
 * widened `Schema.Uint8Array` (typed `Uint8Array<ArrayBufferLike>`) to
 * match the service signatures and the raw wasm-bindgen return type —
 * `Transferable.Uint8Array` would narrow to `Uint8Array<ArrayBuffer>`
 * and force casts at every call site.
 */
const Bytes = Transferable.schema(Schema.Uint8Array, (u) => [u.buffer]);

export class Ed25519Verify extends Rpc.make("Ed25519Verify", {
  payload: {
    message: Bytes,
    signature: Bytes,
    publicKey: Bytes,
  },
  success: Schema.Boolean,
  error: CryptoOpError,
}) {}

export class KesSum6Verify extends Rpc.make("KesSum6Verify", {
  payload: {
    signature: Bytes,
    period: Schema.Number,
    publicKey: Bytes,
    message: Bytes,
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
    vrfVkey: Bytes,
    vrfProof: Bytes,
    vrfInput: Bytes,
  },
  success: Bytes,
  error: CryptoOpError,
}) {}

export class VrfProofToHash extends Rpc.make("VrfProofToHash", {
  payload: { vrfProof: Bytes },
  success: Bytes,
  error: CryptoOpError,
}) {}

export class Blake2b256 extends Rpc.make("Blake2b256", {
  payload: { data: Bytes },
  success: Bytes,
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
