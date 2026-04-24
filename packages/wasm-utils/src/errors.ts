import { Schema } from "effect";

import { CryptoError as WasmCryptoError } from "../pkg/wasm_utils.js";

export const CryptoErrorKind = Schema.Literals([
  "BadLength",
  "InvalidKey",
  "InvalidSig",
  "InvalidProof",
  "VerifyFailed",
  "Parse",
  "Address",
  "Unknown",
]);
export type CryptoErrorKind = typeof CryptoErrorKind.Type;

/** Enumerates every WASM-backed `Crypto` op. Narrowed from `Schema.String`
 * so TS catches typos at `fromWasmError(...)` / `new CryptoOpError(...)`
 * call sites; also lets consumers `Match.value(e.operation)` exhaustively. */
export const CryptoOperation = Schema.Literals([
  "blake2b256",
  "ed25519Verify",
  "kesSum6Verify",
  "checkVrfLeader",
  "vrfVerifyProof",
  "vrfProofToHash",
]);
export type CryptoOperation = typeof CryptoOperation.Type;

const CODE_TO_KIND: ReadonlyMap<number, CryptoErrorKind> = new Map([
  [1, "BadLength"],
  [2, "InvalidKey"],
  [3, "InvalidSig"],
  [4, "InvalidProof"],
  [5, "VerifyFailed"],
  [6, "Parse"],
  [7, "Address"],
]);

export class CryptoOpError extends Schema.TaggedErrorClass<CryptoOpError>()(
  "wasm-utils/CryptoOpError",
  {
    operation: CryptoOperation,
    kind: CryptoErrorKind,
    code: Schema.Number,
    message: Schema.String,
  },
) {}

export const fromWasmError = (operation: CryptoOperation, err: unknown): CryptoOpError => {
  if (err instanceof WasmCryptoError) {
    const code = err.code;
    const kind = CODE_TO_KIND.get(code) ?? "Unknown";
    return new CryptoOpError({
      operation,
      kind,
      code,
      message: err.message,
    });
  }
  return new CryptoOpError({
    operation,
    kind: "Unknown",
    code: 0,
    message: err instanceof Error ? err.message : String(err),
  });
};
