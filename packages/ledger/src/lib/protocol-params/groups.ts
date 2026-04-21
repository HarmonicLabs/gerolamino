/**
 * Conway §20 protocol-parameter group membership.
 *
 * Every PParams field belongs to exactly one DRep group
 * (Network | Economic | Technical | Governance) and either the Security
 * group or no stake-pool group. `modifiedDRepGroups(ppu)` returns the DRep
 * groups touched by a PParamsUpdate — these determine which DRep voting
 * threshold applies. `isSecurityRelevant(ppu)` is true iff any touched field
 * is in SecurityGroup, which requires an SPO vote under Conway.
 *
 * Ground truth:
 *   ~/code/reference/IntersectMBO/cardano-ledger/eras/conway/impl/src/
 *     Cardano/Ledger/Conway/PParams.hs
 *   THKD ('PPGroups drep stakepool) annotations on each ConwayPParams field.
 */

import { HashSet } from "effect";
import type { PParamsUpdate } from "./protocol-params.ts";

export enum DRepGroup {
  Network = "network",
  Economic = "economic",
  Technical = "technical",
  Governance = "governance",
}

export enum StakePoolGroup {
  Security = "security",
  NoStakePool = "noStakePool",
}

export interface PPGroups {
  readonly drep: DRepGroup;
  readonly spo: StakePoolGroup;
}

const G = (drep: DRepGroup, spo: StakePoolGroup): PPGroups => ({ drep, spo });

export const fieldGroups: { readonly [K in keyof PParamsUpdate]-?: PPGroups } = {
  maxBlockBodySize: G(DRepGroup.Network, StakePoolGroup.Security),
  maxTxSize: G(DRepGroup.Network, StakePoolGroup.Security),
  maxBlockHeaderSize: G(DRepGroup.Network, StakePoolGroup.Security),
  maxBlockExUnits: G(DRepGroup.Network, StakePoolGroup.Security),
  maxValSize: G(DRepGroup.Network, StakePoolGroup.Security),
  maxTxExUnits: G(DRepGroup.Network, StakePoolGroup.NoStakePool),
  maxCollateralInputs: G(DRepGroup.Network, StakePoolGroup.NoStakePool),
  minFeeA: G(DRepGroup.Economic, StakePoolGroup.Security),
  minFeeB: G(DRepGroup.Economic, StakePoolGroup.Security),
  coinsPerUTxOByte: G(DRepGroup.Economic, StakePoolGroup.Security),
  minFeeRefScriptCoinsPerByte: G(DRepGroup.Economic, StakePoolGroup.Security),
  keyDeposit: G(DRepGroup.Economic, StakePoolGroup.NoStakePool),
  poolDeposit: G(DRepGroup.Economic, StakePoolGroup.NoStakePool),
  monetaryExpansion: G(DRepGroup.Economic, StakePoolGroup.NoStakePool),
  treasuryCut: G(DRepGroup.Economic, StakePoolGroup.NoStakePool),
  prices: G(DRepGroup.Economic, StakePoolGroup.NoStakePool),
  eMax: G(DRepGroup.Technical, StakePoolGroup.NoStakePool),
  nOpt: G(DRepGroup.Technical, StakePoolGroup.NoStakePool),
  a0: G(DRepGroup.Technical, StakePoolGroup.NoStakePool),
  costModels: G(DRepGroup.Technical, StakePoolGroup.NoStakePool),
  collateralPercentage: G(DRepGroup.Technical, StakePoolGroup.NoStakePool),
  govActionDeposit: G(DRepGroup.Governance, StakePoolGroup.Security),
  poolThresholds: G(DRepGroup.Governance, StakePoolGroup.NoStakePool),
  drepThresholds: G(DRepGroup.Governance, StakePoolGroup.NoStakePool),
  ccMinSize: G(DRepGroup.Governance, StakePoolGroup.NoStakePool),
  ccMaxTermLength: G(DRepGroup.Governance, StakePoolGroup.NoStakePool),
  govActionLifetime: G(DRepGroup.Governance, StakePoolGroup.NoStakePool),
  drepDeposit: G(DRepGroup.Governance, StakePoolGroup.NoStakePool),
  drepActivity: G(DRepGroup.Governance, StakePoolGroup.NoStakePool),
};

const updateKeys = Object.keys(fieldGroups) as ReadonlyArray<keyof PParamsUpdate>;

const touchedFields = (ppu: PParamsUpdate): ReadonlyArray<keyof PParamsUpdate> =>
  updateKeys.filter((k) => ppu[k] !== undefined);

export const modifiedDRepGroups = (ppu: PParamsUpdate): HashSet.HashSet<DRepGroup> =>
  HashSet.fromIterable(touchedFields(ppu).map((k) => fieldGroups[k].drep));

export const modifiedPPGroups = (ppu: PParamsUpdate): HashSet.HashSet<PPGroups> =>
  HashSet.fromIterable(touchedFields(ppu).map((k) => fieldGroups[k]));

export const isSecurityRelevant = (ppu: PParamsUpdate): boolean =>
  touchedFields(ppu).some((k) => fieldGroups[k].spo === StakePoolGroup.Security);
