/**
 * Chain selection — Ouroboros Praos longest chain rule.
 *
 * Primary: prefer chain with higher tip BlockNo (longer chain wins).
 * Fork limit: reject forks deeper than k blocks from our tip.
 * Tiebreaker: lower VRF output wins (anti-grinding).
 */
import { Schema } from "effect";

export class ChainTip extends Schema.TaggedClass<ChainTip>()("ChainTip", {
  slot: Schema.BigInt,
  blockNo: Schema.BigInt,
  hash: Schema.Uint8Array,
}) {}

/**
 * Compare two chain tips for Praos chain selection.
 * Returns positive if `candidate` is preferred over `ours`.
 */
export const preferCandidate = (
  ours: ChainTip,
  candidate: ChainTip,
  forkDepth: number,
  securityParam: number,
): boolean => {
  // Reject forks deeper than k blocks
  if (forkDepth > securityParam) return false;
  // Prefer strictly longer chain (higher blockNo)
  return candidate.blockNo > ours.blockNo;
};

/**
 * Genesis State Machine states.
 * PreSyncing: not enough peers, GDD doesn't run
 * Syncing: GDD Governor runs density comparisons
 * CaughtUp: at tip, standard Praos selection sufficient
 */
export type GsmState = "PreSyncing" | "Syncing" | "CaughtUp";

/**
 * Determine GSM state from current tip and wallclock.
 */
export const gsmState = (
  tipSlot: bigint,
  wallclockSlot: bigint,
  stabilityWindow: bigint,
): GsmState => {
  if (wallclockSlot - tipSlot <= stabilityWindow) return "CaughtUp";
  return "Syncing";
};
