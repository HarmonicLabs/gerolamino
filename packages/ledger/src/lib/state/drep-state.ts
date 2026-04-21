import { Schema } from "effect";
import {
  cborTaggedLink,
  positionalArrayLink,
  strictMaybe,
  toCodecCbor,
  toCodecCborBytes,
  withCborLink,
} from "codecs";
import { StateCredential } from "../core/credentials.ts";
import { Epoch } from "../core/primitives.ts";
import { Anchor } from "../governance/governance.ts";

// ────────────────────────────────────────────────────────────────────────────
// DelegatorSet — Tag(258, Array<StateCredential>)
// Conway's delegator set uses the §4.3 non-empty-set wrapper.
// ────────────────────────────────────────────────────────────────────────────

export const DelegatorSet = Schema.Array(StateCredential).pipe(
  withCborLink((walked) => cborTaggedLink(258n)(walked)),
);
export type DelegatorSet = typeof DelegatorSet.Type;

// ────────────────────────────────────────────────────────────────────────────
// DRepState — `Array(4): [expiry, StrictMaybe(anchor), deposit, delegators]`
//
// The `expiry` slot drives the dormancy sweep on EPOCH boundary
// (Conway §14.6): a DRep with `expiry ≤ currentEpoch` is considered
// inactive and skipped during tally.
//
// Haskell ref: `eras/conway/impl/src/Cardano/Ledger/Conway/Governance/DRepPulser.hs`
// `eras/conway/impl/src/Cardano/Ledger/Conway/State/VState.hs`.
// ────────────────────────────────────────────────────────────────────────────

export const DRepState = Schema.Struct({
  expiry: Epoch,
  anchor: strictMaybe(toCodecCbor(Anchor)),
  deposit: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
  delegators: DelegatorSet,
}).pipe(
  withCborLink((walked) =>
    positionalArrayLink(["expiry", "anchor", "deposit", "delegators"])(walked),
  ),
);
export type DRepState = typeof DRepState.Type;

export const DRepStateBytes = toCodecCborBytes(DRepState);
export const DRepStateCbor = toCodecCbor(DRepState);

// ────────────────────────────────────────────────────────────────────────────
// Dormancy predicate — a DRep is inactive once `expiry ≤ currentEpoch`.
// Consumers filter VState.dreps with this to obtain the active tally set.
// ────────────────────────────────────────────────────────────────────────────

export const isDormant =
  (currentEpoch: Epoch) =>
  (state: DRepState): boolean =>
    state.expiry <= currentEpoch;

export const isActive =
  (currentEpoch: Epoch) =>
  (state: DRepState): boolean =>
    state.expiry > currentEpoch;
