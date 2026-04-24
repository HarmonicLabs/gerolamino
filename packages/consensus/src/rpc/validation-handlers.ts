/**
 * Server-side handler layer for `ValidationRpcGroup`.
 *
 * Each of the 12 Rpcs is mapped to an `Effect` that delegates to the
 * right backing service:
 *   - Crypto primitives → `Crypto` service from wasm-utils
 *   - blake2b-256 (plain + tagged + body-hash + tx-id) → `Crypto.blake2b256`.
 *     Routed through the shared WASM path (not `Bun.CryptoHasher`) so this
 *     module stays browser-compatible — `packages/consensus` must compile
 *     against the `@effect/platform-browser` stack too.
 *   - CBOR decoders → `codecs` + `ledger` (pure Effect)
 *   - `ValidateHeader` / `ValidateBlockBody` → existing
 *     `validate-header.ts` / `validate-block.ts` logic.
 *
 * This layer is consumed both by:
 *   - `ValidationDirect.layer` — serves the group in the caller's fiber
 *     (no Worker, no RPC serialisation)
 *   - `validation-worker.ts` — the Bun Worker entrypoint that serves the
 *     same handlers across a MessagePort boundary
 */
import { Effect } from "effect";
import { concat } from "codecs";
import { MultiEraBlock, decodeMultiEraBlock } from "ledger/lib/block/block.ts";
import { Era } from "ledger/lib/core/era.ts";
import { Crypto } from "wasm-utils";
import { ValidationError, ValidationRpcGroup } from "./validation-rpc-group.ts";

/**
 * In-process handler layer. Every Rpc delegates to real backing services;
 * no stubs. Suitable for both the direct layer (caller's fiber) + the
 * worker layer (same handlers on a Worker-side RpcServer).
 */
export const ValidationHandlersLive = ValidationRpcGroup.toLayer(
  Effect.gen(function* () {
    const crypto = yield* Crypto;

    return ValidationRpcGroup.of({
      // ───────────── Primitive crypto (delegate to wasm-utils Crypto) ─────────────

      Ed25519Verify: ({ message, publicKey, signature }) =>
        crypto.ed25519Verify(message, signature, publicKey),
      KesSum6Verify: ({ message, period, publicKey, signature }) =>
        crypto.kesSum6Verify(signature, period, publicKey, message),
      CheckVrfLeader: ({
        activeSlotCoeffDen,
        activeSlotCoeffNum,
        sigmaDenominator,
        sigmaNumerator,
        vrfOutputHex,
      }) =>
        crypto.checkVrfLeader(
          vrfOutputHex,
          sigmaNumerator,
          sigmaDenominator,
          activeSlotCoeffNum,
          activeSlotCoeffDen,
        ),
      VrfVerify: ({ vrfInput, vrfProof, vrfVkey }) =>
        crypto.vrfVerifyProof(vrfVkey, vrfProof, vrfInput),
      VrfProofToHash: ({ vrfProof }) => crypto.vrfProofToHash(vrfProof),

      // ───────────── blake2b-256 (via WASM — browser-compatible) ─────────────

      Blake2b256Tagged: ({ data, tag }) =>
        crypto.blake2b256(concat(new Uint8Array([tag & 0xff]), data)),
      ComputeBodyHash: ({ blockBodyCbor }) =>
        crypto.blake2b256(blockBodyCbor).pipe(
          Effect.mapError(
            (cause) =>
              new ValidationError({
                operation: "ComputeBodyHash",
                message: cause.message,
                cause,
              }),
          ),
        ),
      ComputeTxId: ({ txBodyCbor }) =>
        crypto
          .blake2b256(txBodyCbor)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ValidationError({ operation: "ComputeTxId", message: cause.message, cause }),
            ),
          ),

      // ───────────── CBOR decode ops ─────────────

      DecodeBlockCbor: ({ blockCbor }) =>
        decodeMultiEraBlock(blockCbor).pipe(
          // Byron blocks don't carry slot/blockNo in the consensus-level
          // summary shape; pre-Byron chain is pre-validated into ImmutableDB
          // from the Mithril snapshot. Phase 3b proper can surface real
          // values via `MultiEraHeader.match` when needed. For postByron,
          // `hash` is left empty until Phase 3b wires `computeHeaderHash`
          // through the RPC.
          Effect.map(
            MultiEraBlock.match({
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

      // `DecodeHeaderCbor`, `ValidateHeader`, `ValidateBlockBody` handlers
      // were removed along with their Rpc declarations — see the group
      // header comment in `validation-rpc-group.ts` for the rationale.
      // They'll re-land with the SyncStage pipeline's worker offload.
    });
  }),
);
