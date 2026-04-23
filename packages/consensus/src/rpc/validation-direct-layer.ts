/**
 * `ValidationDirectLayer` — in-process ValidationClient implementation.
 *
 * Every method delegates directly to its backing service (`Crypto` from
 * wasm-utils, `codecs` + `ledger` decoders, `Bun.CryptoHasher` for
 * blake2b). No Worker, no RPC serialisation, no transport boundary.
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
import { MultiEraBlock, decodeMultiEraBlock } from "ledger/lib/block/block.ts";
import { Era } from "ledger/lib/core/era.ts";
import { Crypto } from "wasm-utils";
import { ValidationClient } from "./validation-client.ts";
import { ValidationError } from "./validation-rpc-group.ts";

const blake2b256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(new Bun.CryptoHasher("blake2b256").update(data).digest().buffer);

const blake2b256Tagged = (tag: number, data: Uint8Array): Uint8Array => {
  const combined = new Uint8Array(1 + data.byteLength);
  combined[0] = tag & 0xff;
  combined.set(data, 1);
  return blake2b256(combined);
};

const notImplemented = (operation: string, detail: string) =>
  Effect.fail(
    new ValidationError({
      operation,
      message: `${operation}: ${detail}`,
    }),
  );

export const ValidationDirectLayer: Layer.Layer<ValidationClient, never, Crypto> = Layer.effect(
  ValidationClient,
  Effect.gen(function* () {
    const crypto = yield* Crypto;

    return ValidationClient.of({
      // ───────────── Consensus-level ─────────────

      // Phase 3b wires these into validate-header.ts / validate-block.ts.
      // Until that lands, signal not-yet-implemented so callers can detect
      // and fall back to the existing direct validators.
      validateHeader: () =>
        notImplemented(
          "ValidateHeader",
          "Phase 3b wires this into validate-header.ts + LedgerView",
        ),
      validateBlockBody: () =>
        notImplemented(
          "ValidateBlockBody",
          "Phase 3b wires this into validate-block.ts + ComputeBodyHash",
        ),

      computeBodyHash: (blockBodyCbor) =>
        Effect.try({
          try: () => blake2b256(blockBodyCbor),
          catch: (err) =>
            new ValidationError({ operation: "ComputeBodyHash", message: String(err), cause: err }),
        }),
      computeTxId: (txBodyCbor) =>
        Effect.try({
          try: () => blake2b256(txBodyCbor),
          catch: (err) =>
            new ValidationError({ operation: "ComputeTxId", message: String(err), cause: err }),
        }),

      decodeHeaderCbor: () =>
        notImplemented(
          "DecodeHeaderCbor",
          "use decodeBlockCbor until Phase 3b wires dedicated header decode",
        ),

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
        crypto.blake2b256(data).pipe(
          Effect.flatMap(() =>
            // Use Bun-native blake2b for tagged hashes — WASM path is only
            // needed for ed25519/KES/VRF where Rust-optimised beats native.
            Effect.succeed(blake2b256Tagged(tag, data)),
          ),
        ),
    });
  }),
);
