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
// Distinct from `PoolParams` (block/CDDL wire), which has 9 slots with
// operator at position 0 and no deposit slot. Each codec has its own
// `positionalArrayLink` field ordering — no runtime branching.
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
