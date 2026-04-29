/**
 * Chain selection — Ouroboros Praos rules.
 *
 * Per Haskell `comparePraos` (`Praos/Common.hs:126-169`):
 *   1. Higher blockNo wins (longer chain). The primary `SelectView` for
 *      vanilla Praos is BlockNo only — everything below is a tiebreaker.
 *   2. At equal blockNo, lower VRF tiebreak value wins (anti-grinding).
 *      OCert-issue-no comparison only applies when slots AND issuers
 *      coincide (a degenerate case for cross-pool comparisons), so for
 *      the peer-tip selection use here it collapses to the VRF rule.
 *   3. Reject forks deeper than `k` blocks (security parameter).
 *
 * The previous "lower slot wins (denser chain)" rule was a Genesis-mode
 * heuristic — Praos itself does NOT use slot-density as a tiebreaker.
 * Two blocks at the same blockNo from different issuers are settled by
 * VRF only; their slot delta is irrelevant to the choice (Haskell's
 * `RestrictedVRFTiebreaker` uses slot distance only as a *gate* on
 * whether VRF applies, not as a comparison).
 */
import { Schema } from "effect";
import { compareBytes } from "codecs";

export class ChainTip extends Schema.TaggedClass<ChainTip>()("ChainTip", {
  slot: Schema.BigInt,
  blockNo: Schema.BigInt,
  hash: Schema.Uint8Array,
  /** VRF output for tiebreaking (optional — absent for genesis / Byron). */
  vrfOutput: Schema.optional(Schema.Uint8Array),
}) {}

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
  // Rule 0: reject forks deeper than k blocks (consensus-stability gate)
  if (forkDepth > securityParam) return false;

  // Rule 1: higher blockNo wins (longer chain)
  if (candidate.blockNo > ours.blockNo) return true;
  if (candidate.blockNo < ours.blockNo) return false;

  // Rule 2 (tiebreak): equal blockNo → lower VRF output wins.
  // Both VRFs must be present for the comparison to be defined; if either
  // is absent (Byron tip, or pre-validation peer state) we cannot form an
  // ordering and stick with the current tip — matches Haskell's
  // `vrfArmed = False ⇒ ShouldNotSwitch EQ` branch.
  if (candidate.vrfOutput && ours.vrfOutput) {
    return compareBytes(candidate.vrfOutput, ours.vrfOutput) < 0;
  }

  // Tiebreak unavailable — no preference.
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
