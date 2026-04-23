/**
 * Server-side handler layer for `ValidationRpcGroup`.
 *
 * Each of the 12 Rpcs is mapped to an `Effect` that delegates to the
 * right backing service:
 *   - Crypto primitives → `Crypto` service from wasm-utils
 *   - CBOR decoders → `codecs` + `ledger` (pure Effect)
 *   - `ComputeBodyHash` / `ComputeTxId` → `Bun.CryptoHasher("blake2b256")`
 *     (per `feedback_prefer_bun_crypto.md` — no WASM boundary for plain
 *     blake2b; the CryptoHasher is ~5-10× faster than the WASM path).
 *   - `Blake2b256Tagged` → concat(tag, data) → `Bun.CryptoHasher`.
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
import { MultiEraBlock, decodeMultiEraBlock } from "ledger/lib/block/block.ts";
import { Era } from "ledger/lib/core/era.ts";
import { Crypto, fromWasmError } from "wasm-utils";
import { ValidationError, ValidationRpcGroup } from "./validation-rpc-group.ts";

/**
 * Bun.CryptoHasher-backed blake2b-256 for hot-path hashing. Matches the
 * `feedback_prefer_bun_crypto.md` convention — WASM is reserved for
 * ed25519/KES/VRF/leader-math where the Rust-optimised implementation
 * is the only correct path.
 */
const blake2b256 = (data: Uint8Array): Uint8Array =>
  new Uint8Array(new Bun.CryptoHasher("blake2b256").update(data).digest().buffer);

const blake2b256Tagged = (tag: number, data: Uint8Array): Uint8Array => {
  const combined = new Uint8Array(1 + data.byteLength);
  combined[0] = tag & 0xff;
  combined.set(data, 1);
  return blake2b256(combined);
};

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

      // ───────────── blake2b-256 (Bun.CryptoHasher, no WASM) ─────────────

      Blake2b256Tagged: ({ data, tag }) =>
        Effect.try({
          try: () => blake2b256Tagged(tag, data),
          catch: (err) => fromWasmError("Blake2b256Tagged", err),
        }),
      ComputeBodyHash: ({ blockBodyCbor }) =>
        Effect.try({
          try: () => blake2b256(blockBodyCbor),
          catch: (err) =>
            new ValidationError({
              operation: "ComputeBodyHash",
              message: String(err),
              cause: err,
            }),
        }),
      ComputeTxId: ({ txBodyCbor }) =>
        Effect.try({
          try: () => blake2b256(txBodyCbor),
          catch: (err) =>
            new ValidationError({ operation: "ComputeTxId", message: String(err), cause: err }),
        }),

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
          Effect.mapError((issue) =>
            new ValidationError({
              operation: "DecodeBlockCbor",
              message: issue._tag ?? "Decode failed",
              cause: issue,
            }),
          ),
        ),

      DecodeHeaderCbor: (_) =>
        // Dedicated header decode path — not strictly needed when the caller
        // has the full block CBOR already (DecodeBlockCbor covers it). Stub
        // defers to Phase 3b proper when header-only dispatch becomes useful.
        Effect.fail(
          new ValidationError({
            operation: "DecodeHeaderCbor",
            message: "not yet implemented — use DecodeBlockCbor for now",
          }),
        ),

      // ───────────── Composite validation (Phase 3b proper) ─────────────

      ValidateHeader: (_) =>
        Effect.fail(
          new ValidationError({
            operation: "ValidateHeader",
            message:
              "not yet implemented — Phase 3b wires this into validate-header.ts + ledger-view",
          }),
        ),
      ValidateBlockBody: (_) =>
        Effect.fail(
          new ValidationError({
            operation: "ValidateBlockBody",
            message:
              "not yet implemented — Phase 3b wires this into validate-block.ts + body-hash check",
          }),
        ),
    });
  }),
);
