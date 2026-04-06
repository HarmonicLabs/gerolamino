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
import { Schema } from "effect";

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
export const evolveNonce = async (
  currentNonce: Uint8Array,
  vrfNonceOutput: Uint8Array,
): Promise<Uint8Array> => {
  // TODO: use wasm-utils blake2b once available
  const hasher = new Bun.CryptoHasher("blake2b256");
  const innerHash = hasher.update(vrfNonceOutput).digest();
  const outerHasher = new Bun.CryptoHasher("blake2b256");
  return new Uint8Array(
    outerHasher.update(currentNonce).update(innerHash).digest().buffer,
  );
};

/**
 * Derive epoch nonce from candidate nonce and epoch boundary block hash.
 * fromCandidate(candidate, parentHash) = blake2b-256(candidate ∥ parentHash)
 */
export const deriveEpochNonce = async (
  candidateNonce: Uint8Array,
  parentHash: Uint8Array,
): Promise<Uint8Array> => {
  const hasher = new Bun.CryptoHasher("blake2b256");
  return new Uint8Array(
    hasher.update(candidateNonce).update(parentHash).digest().buffer,
  );
};

/**
 * Check if a slot is past the randomness stabilization window.
 * After 4k/f slots into an epoch, the candidate nonce is frozen.
 */
export const isPastStabilizationWindow = (
  slotInEpoch: bigint,
  securityParam: number,
  activeSlotsCoeff: number,
): boolean => {
  const stabilizationWindow = Math.ceil((4 * securityParam) / activeSlotsCoeff);
  return slotInEpoch >= BigInt(stabilizationWindow);
};
