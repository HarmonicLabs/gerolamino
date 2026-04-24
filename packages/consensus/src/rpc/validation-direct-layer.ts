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
import { concat } from "codecs";
import { MultiEraBlock, decodeMultiEraBlock } from "ledger/lib/block/block.ts";
import { Era } from "ledger/lib/core/era.ts";
import { Crypto } from "wasm-utils";
import { ValidationClient, mapCryptoToValidation } from "./validation-client.ts";
import { ValidationError } from "./validation-rpc-group.ts";

export const ValidationDirectLayer: Layer.Layer<ValidationClient, never, Crypto> = Layer.effect(
  ValidationClient,
  Effect.gen(function* () {
    const crypto = yield* Crypto;

    return ValidationClient.of({
      // ───────────── Consensus-level ─────────────

      computeBodyHash: (blockBodyCbor) =>
        crypto
          .blake2b256(blockBodyCbor)
          .pipe(Effect.mapError(mapCryptoToValidation("ComputeBodyHash"))),
      computeTxId: (txBodyCbor) =>
        crypto.blake2b256(txBodyCbor).pipe(Effect.mapError(mapCryptoToValidation("ComputeTxId"))),

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

      // ───────────── Primitive crypto (delegates to Crypto) ─────────────

      ed25519Verify: (message, signature, publicKey) =>
        crypto.ed25519Verify(message, signature, publicKey),
      kesSum6Verify: (signature, period, publicKey, message) =>
        crypto.kesSum6Verify(signature, period, publicKey, message),
      checkVrfLeader: (a, b, c, d, e) => crypto.checkVrfLeader(a, b, c, d, e),
      vrfVerify: (vrfVkey, vrfProof, vrfInput) =>
        crypto.vrfVerifyProof(vrfVkey, vrfProof, vrfInput),
      vrfProofToHash: (vrfProof) => crypto.vrfProofToHash(vrfProof),
      blake2b256Tagged: (tag, data) =>
        // prepend the tag byte and hash — keeps hashing on the shared
        // WASM path so the browser build works. `concat` comes from
        // `codecs` so we don't hand-roll a join.
        crypto.blake2b256(concat(new Uint8Array([tag & 0xff]), data)),
    });
  }),
);
