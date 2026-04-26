/**
 * `ValidationDirectLayer` — in-process ValidationClient implementation.
 *
 * Every method delegates directly to its backing service (`Crypto` from
 * wasm-utils for blake2b-256 + the remaining primitives, `codecs` +
 * `ledger` decoders for the CBOR reads). No Worker, no RPC serialisation,
 * no transport boundary.
 *
 * The blake2b path goes through the shared WASM `Crypto.blake2b256`
 * (not `Bun.CryptoHasher`) so this module stays browser-compatible —
 * `packages/consensus` must compile against the `@effect/platform-browser`
 * stack too, and `Bun.CryptoHasher` has no browser equivalent.
 *
 * Use in:
 *   - Unit tests (paired with `CryptoDirect` from wasm-utils)
 *   - Small batches below the Phase 1c benchmark's per-call overhead
 *     crossover (~500 calls/batch for blake2b on <1KB inputs)
 *   - Hot-path carve-outs documented in `packages/consensus/CLAUDE.md`
 *
 * Requires `Crypto` (provided by `CryptoDirect` or `CryptoWorkerBun` from
 * wasm-utils) in the app's layer composition.
 */
import { Effect, Layer } from "effect";
import { Crypto } from "wasm-utils";
import { ValidationClient, makeLocalValidationOps } from "./validation-client.ts";

export const ValidationDirectLayer: Layer.Layer<ValidationClient, never, Crypto> = Layer.effect(
  ValidationClient,
  Effect.gen(function* () {
    const crypto = yield* Crypto;

    return ValidationClient.of({
      // Consensus-level + tagged-blake ops are the same in both Direct and
      // RPC layers — sourced from the shared `makeLocalValidationOps` so
      // they can't drift on error-shape conventions.
      ...makeLocalValidationOps(crypto),

      // Primitive crypto — straight delegation to the in-process Crypto
      // service. The RPC layer's variants forward through `client.X(...)`
      // + `catchTransport(...)`; this layer skips that boundary.
      ed25519Verify: (message, signature, publicKey) =>
        crypto.ed25519Verify(message, signature, publicKey),
      kesSum6Verify: (signature, period, publicKey, message) =>
        crypto.kesSum6Verify(signature, period, publicKey, message),
      checkVrfLeader: (a, b, c, d, e) => crypto.checkVrfLeader(a, b, c, d, e),
      vrfVerify: (vrfVkey, vrfProof, vrfInput) =>
        crypto.vrfVerifyProof(vrfVkey, vrfProof, vrfInput),
      vrfProofToHash: (vrfProof) => crypto.vrfProofToHash(vrfProof),
    });
  }),
);
