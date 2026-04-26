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
import { Crypto } from "wasm-utils";
import { makeLocalValidationOps } from "./validation-client.ts";
import { ValidationRpcGroup } from "./validation-rpc-group.ts";

/**
 * In-process handler layer. Every Rpc delegates to real backing services;
 * no stubs. Suitable for both the direct layer (caller's fiber) + the
 * worker layer (same handlers on a Worker-side RpcServer).
 */
export const ValidationHandlersLive = ValidationRpcGroup.toLayer(
  Effect.gen(function* () {
    const crypto = yield* Crypto;
    // The four "local" ops (blake2b body-hash / tx-id / tagged + block-CBOR
    // decode) share their full implementation with the `ValidationClient`
    // direct + RPC layers via the `makeLocalValidationOps` factory — same
    // error-shape conventions, same Byron-summary fallback in
    // `decodeBlockCbor`. Bind once + reuse so the RPC handler arms reduce
    // to a single-line destructure-and-call.
    const ops = makeLocalValidationOps(crypto);

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

      // ───────────── Local (consensus-level) ops — shared factory ─────────────

      Blake2b256Tagged: ({ data, tag }) => ops.blake2b256Tagged(tag, data),
      ComputeBodyHash: ({ blockBodyCbor }) => ops.computeBodyHash(blockBodyCbor),
      ComputeTxId: ({ txBodyCbor }) => ops.computeTxId(txBodyCbor),
      DecodeBlockCbor: ({ blockCbor }) => ops.decodeBlockCbor(blockCbor),

      // `DecodeHeaderCbor`, `ValidateHeader`, `ValidateBlockBody` handlers
      // were removed along with their Rpc declarations — see the group
      // header comment in `validation-rpc-group.ts` for the rationale.
      // They'll re-land with the SyncStage pipeline's worker offload.
    });
  }),
);
