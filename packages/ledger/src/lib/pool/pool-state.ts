import { Schema } from "effect";
import {
  positionalArrayLink,
  strictMaybe,
  toCodecCbor,
  toCodecCborBytes,
  withCborLink,
} from "codecs";
import { Bytes32 } from "../core/hashes.ts";
import { MAX_WORD64, UnitInterval } from "../core/primitives.ts";
import { Hash28Set } from "../governance/governance.ts";
import { PoolMetadata, Relay, RewardAccount } from "./pool.ts";

// ────────────────────────────────────────────────────────────────────────────
// PoolParamsStatePState — the value type in PState's stakePools / futureParams
// map (operator is the map key, deposit replaces it as slot 8).
//
// CBOR: positional 9-element array
//   [vrfKeyHash, pledge, cost, margin, rewardAccount, owners, relays,
//    metadata, deposit]
//
// NOTE: cardano-ledger v10.7.x renamed this to `StakePoolState` and
// added two trailing fields (`spsDeposit` was promoted from the old
// `deposit` slot, plus a new `spsDelegators :: Set (Credential
// Staking)`), AND restructured the rewardAccount/account-id slot to
// use the structured `AccountAddress` form instead of the packed
// 29-byte `RewardAccount`. This 9-element schema is the older shape
// and will fail to decode a v10.7.x state snapshot. The TUI's
// `loadSnapshotState` wraps the decode in a graceful fallback —
// snapshot ingest fails, consensus falls back to genesis, and the
// node still syncs from the relay against the on-disk LSM session.
// Bringing this back to spec is gated on a coordinated update of
// every state-layer schema (PState, DState, EpochState etc.).
//
// Haskell ref: `cardano-ledger` v10.7.x PState.PoolParams (state-layer) vs
// Shelley/Conway TxBody pool_registration cert (block-layer).
// ────────────────────────────────────────────────────────────────────────────

export const PoolParamsStatePState = Schema.Struct({
  vrfKeyHash: Bytes32,
  pledge: Schema.BigInt.pipe(
    Schema.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: MAX_WORD64 })),
  ),
  cost: Schema.BigInt.pipe(
    Schema.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: MAX_WORD64 })),
  ),
  margin: UnitInterval,
  rewardAccount: RewardAccount,
  owners: Hash28Set,
  relays: Schema.Array(Relay),
  metadata: strictMaybe(toCodecCbor(PoolMetadata)),
  deposit: Schema.BigInt.pipe(
    Schema.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: MAX_WORD64 })),
  ),
}).pipe(
  withCborLink((walked) =>
    positionalArrayLink([
      "vrfKeyHash",
      "pledge",
      "cost",
      "margin",
      "rewardAccount",
      "owners",
      "relays",
      "metadata",
      "deposit",
    ])(walked),
  ),
);
export type PoolParamsStatePState = typeof PoolParamsStatePState.Type;

export const PoolParamsStatePStateBytes = toCodecCborBytes(PoolParamsStatePState);
export const PoolParamsStatePStateCbor = toCodecCbor(PoolParamsStatePState);
