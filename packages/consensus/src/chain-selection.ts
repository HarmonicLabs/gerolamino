/**
 * Chain selection — Ouroboros Praos rules.
 *
 * Per spec (Section 3.4) + Amaru/Dingo implementations:
 *   1. Higher blockNo wins (longer chain)
 *   2. At equal blockNo, lower slot wins (denser chain)
 *   3. At equal slot, lower VRF output wins (anti-grinding tiebreaker)
 *   4. Reject forks deeper than k blocks
 */
import { Schema } from "effect";

export class ChainTip extends Schema.TaggedClass<ChainTip>()("ChainTip", {
  slot: Schema.BigInt,
  blockNo: Schema.BigInt,
  hash: Schema.Uint8Array,
  /** VRF output for tiebreaking (optional — absent for genesis). */
  vrfOutput: Schema.optional(Schema.Uint8Array),
}) {}

/** Lexicographic comparison of two Uint8Arrays. Returns <0, 0, or >0. */
const compareBytes = (a: Uint8Array, b: Uint8Array): number => {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
};

/**
 * Praos chain selection: should we switch from `ours` to `candidate`?
 *
 * @param ours Current chain tip
 * @param candidate Candidate chain tip
 * @param forkDepth How many of our blocks the candidate would discard
 * @param securityParam k — maximum fork depth allowed
 * @returns true if candidate is strictly preferred
 */
export const preferCandidate = (
  ours: ChainTip,
  candidate: ChainTip,
  forkDepth: number,
  securityParam: number,
): boolean => {
  // Rule 0: reject forks deeper than k blocks
  if (forkDepth > securityParam) return false;

  // Rule 1: higher blockNo wins (longer chain)
  if (candidate.blockNo > ours.blockNo) return true;
  if (candidate.blockNo < ours.blockNo) return false;

  // Rule 2: at equal blockNo, lower slot wins (denser chain)
  if (candidate.slot < ours.slot) return true;
  if (candidate.slot > ours.slot) return false;

  // Rule 3: at equal slot, lower VRF output wins (anti-grinding)
  if (candidate.vrfOutput && ours.vrfOutput) {
    return compareBytes(candidate.vrfOutput, ours.vrfOutput) < 0;
  }

  // No preference — stick with current
  return false;
};

/**
 * Genesis State Machine states.
 * PreSyncing: insufficient peers
 * Syncing: behind tip, actively catching up
 * CaughtUp: tip within stability window of wallclock
 */
export const GsmState = Schema.Literals(["PreSyncing", "Syncing", "CaughtUp"]);
export type GsmState = typeof GsmState.Type;

/**
 * Determine GSM state from current tip slot and wallclock slot.
 * Uses SlotClock's stabilityWindow (3k/f slots).
 */
export const gsmState = (
  tipSlot: bigint,
  wallclockSlot: bigint,
  stabilityWindow: bigint,
): GsmState => {
  if (wallclockSlot - tipSlot <= stabilityWindow) return "CaughtUp";
  return "Syncing";
};
