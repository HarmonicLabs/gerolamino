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
import { Crypto, type CryptoOpError } from "wasm-utils";
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
  Effect.gen(function* () {
    const crypto = yield* Crypto;
    return yield* crypto.blake2b256(concat(candidateNonce, parentHash));
  });

/**
 * Check if a slot is past the randomness stabilization window.
 *
 * Per Amaru/Haskell: randomness_stabilization_window = 4k/f slots.
 * The candidate nonce freezes at (epochLength - 4k/f) slots into the epoch.
 * Before that point, candidate = evolving. After, candidate is frozen.
 *
 * For standard params (k=2160, f=0.05): freezes at slot 259,200 of 432,000.
 */
export const isPastStabilizationWindow = (
  slotInEpoch: bigint,
  securityParam: number,
  activeSlotsCoeff: number,
  epochLength: bigint,
): boolean => {
  const stabilizationWindow = Math.ceil((4 * securityParam) / activeSlotsCoeff);
  return slotInEpoch >= epochLength - BigInt(stabilizationWindow);
};
