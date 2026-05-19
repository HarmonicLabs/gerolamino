/**
 * Nonce evolution — Ouroboros Praos randomness.
 *
 * Two VRF evaluations per block:
 *   1. Leader VRF: (y_leader, π_leader) ← ProveVRF(sk, η ∥ sl ∥ "TEST")
 *   2. Nonce VRF:  (y_nonce,  π_nonce)  ← ProveVRF(sk, η ∥ sl ∥ "NONCE")
 *
 * Nonce update: evolve(currentNonce, vrfNonceOutput) = blake2b(currentNonce ∥ blake2b(vrfNonceOutput))
 * Epoch nonce: fromCandidate(candidate, parentHash) = blake2b(candidate ∥ parentHash)
 *
 * Nonce freezing: after 4k/f slots into an epoch, the candidate nonce is frozen.
 */
import { Effect, Schema } from "effect";
import { Crypto } from "wasm-utils/service.ts";
import { type CryptoOpError } from "wasm-utils/errors.ts";
import { concat } from "../util";

export class Nonces extends Schema.TaggedClass<Nonces>()("Nonces", {
  /** Active epoch nonce — for current epoch's leader schedule. */
  active: Schema.Uint8Array,
  /** Evolving nonce — updated each block with VRF nonce output. */
  evolving: Schema.Uint8Array,
  /** Candidate nonce — frozen at randomness stabilization window. */
  candidate: Schema.Uint8Array,
  /** Current epoch number. */
  epoch: Schema.BigInt,
}) {}

/**
 * Evolve the nonce with a new VRF nonce output.
 * evolve(η, y) = blake2b-256(η ∥ blake2b-256(y))
 */
export const evolveNonce = (
  currentNonce: Uint8Array,
  vrfNonceOutput: Uint8Array,
): Effect.Effect<Uint8Array, CryptoOpError, Crypto> =>
  Effect.gen(function* () {
    // `Context.Service` is directly yieldable in effect@4.0.0-beta.67+;
    // `.asEffect()` was removed (it was the beta.47–.59 escape hatch).
    const crypto = yield* Crypto;
    const innerHash = yield* crypto.blake2b256(vrfNonceOutput);
    return yield* crypto.blake2b256(concat(currentNonce, innerHash));
  });

/**
 * Derive epoch nonce from candidate nonce and epoch boundary block hash.
 * fromCandidate(candidate, parentHash) = blake2b-256(candidate ∥ parentHash)
 */
export const deriveEpochNonce = (
  candidateNonce: Uint8Array,
  parentHash: Uint8Array,
): Effect.Effect<Uint8Array, CryptoOpError, Crypto> =>
  // `Crypto.use(fn)` replaces the `Effect.flatMap(Crypto, fn)` shape —
  // same v4-beta-59 Service-isn't-yieldable issue, .use() is the
  // canonical one-shot extractor.
  Crypto.use((crypto) => crypto.blake2b256(concat(candidateNonce, parentHash)));

/**
 * Check if a slot is past the randomness stabilization window.
 *
 * Per Haskell `Cardano.Ledger.Shelley.StabilityWindow.computeRandomnessStabilisationWindow`:
 *   `randomnessStabilisationWindow = ⌈4k / f⌉`
 * The candidate nonce freezes at `epochLength - ⌈4k/f⌉` slots into the
 * epoch; before that, candidate = evolving; after, candidate is frozen.
 *
 * Direct float division + `Math.ceil` matches the Haskell `ceiling`
 * exactly. The previous `4·k·1000/round(f·1000)` formulation lost
 * precision when `f · 1000` happened to round (e.g., `f =
 * 0.001000250...` rounded to `1`, inflating the window 1000×); both
 * mainnet (k=2160, f=0.05) and synthetic property-test parameters are
 * within `Number.MAX_SAFE_INTEGER`, so float arithmetic is the
 * spec-faithful path.
 *
 * For standard mainnet params (k=2160, f=0.05): `⌈4·2160 / 0.05⌉ =
 * 172800` exactly; freezes at slot 259,200 of the 432,000-slot epoch.
 */
export const isPastStabilizationWindow = (
  slotInEpoch: bigint,
  securityParam: number,
  activeSlotsCoeff: number,
  epochLength: bigint,
): boolean => {
  // Guard against a configuration where `f ≤ 0` — would otherwise divide
  // by zero / negative and return a nonsense window. Practical parameters
  // never hit this; the explicit fallback keeps the pure helper safe to
  // call from unit tests with synthetic values.
  if (activeSlotsCoeff <= 0) return false;
  const stabilizationWindow = Math.ceil((4 * securityParam) / activeSlotsCoeff);
  return slotInEpoch >= epochLength - BigInt(stabilizationWindow);
};
