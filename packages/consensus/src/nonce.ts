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

const bunBlake2b256 = (data: Uint8Array): Uint8Array => {
  const hasher = new Bun.CryptoHasher("blake2b256");
  return new Uint8Array(hasher.update(data).digest().buffer);
};

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
};

/**
 * Evolve the nonce with a new VRF nonce output.
 * evolve(η, y) = blake2b-256(η ∥ blake2b-256(y))
 *
 * Uses Bun.CryptoHasher for blake2b (native, fast).
 */
export const evolveNonce = (
  currentNonce: Uint8Array,
  vrfNonceOutput: Uint8Array,
  blake2b256: (data: Uint8Array) => Uint8Array = bunBlake2b256,
): Uint8Array => {
  const innerHash = blake2b256(vrfNonceOutput);
  return blake2b256(concat(currentNonce, innerHash));
};

/**
 * Derive epoch nonce from candidate nonce and epoch boundary block hash.
 * fromCandidate(candidate, parentHash) = blake2b-256(candidate ∥ parentHash)
 *
 * Uses Bun.CryptoHasher for blake2b (native, fast).
 */
export const deriveEpochNonce = (
  candidateNonce: Uint8Array,
  parentHash: Uint8Array,
  blake2b256: (data: Uint8Array) => Uint8Array = bunBlake2b256,
): Uint8Array => blake2b256(concat(candidateNonce, parentHash));

/**
 * Check if a slot is past the randomness stabilization window.
 *
 * Per Praos spec Section 5.2: epoch has R = 24k/f slots total.
 * First 16k/f slots: candidate nonce collection period.
 * Last 8k/f slots: stabilization (quiet) period — nonce is frozen.
 *
 * The candidate nonce freezes at slot 16k/f into the epoch.
 */
export const isPastStabilizationWindow = (
  slotInEpoch: bigint,
  securityParam: number,
  activeSlotsCoeff: number,
): boolean => {
  // Candidate collection ends at 16k/f, quiet period is last 8k/f
  const candidateCollectionEnd = Math.ceil((16 * securityParam) / activeSlotsCoeff);
  return slotInEpoch >= BigInt(candidateCollectionEnd);
};
