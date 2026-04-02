import { Schema } from "effect"
import { Rational } from "./primitives.ts"

// ────────────────────────────────────────────────────────────────────────────
// DRep Thresholds (P1..P6, 10 fields per spec Section 8)
// ────────────────────────────────────────────────────────────────────────────

export const DRepThresholds = Schema.Struct({
  p1: Rational,    // NoConfidence
  p2a: Rational,   // UpdateCommittee (normal)
  p2b: Rational,   // UpdateCommittee (no confidence state)
  p3: Rational,    // NewConstitution
  p4: Rational,    // TriggerHF
  p5a: Rational,   // ChangePParams (network)
  p5b: Rational,   // ChangePParams (economic)
  p5c: Rational,   // ChangePParams (technical)
  p5d: Rational,   // ChangePParams (governance)
  p6: Rational,    // TreasuryWdrl
})
export type DRepThresholds = Schema.Schema.Type<typeof DRepThresholds>

// ────────────────────────────────────────────────────────────────────────────
// Pool Thresholds (Q1..Q5, 5 fields per spec Section 8)
// ────────────────────────────────────────────────────────────────────────────

export const PoolThresholds = Schema.Struct({
  q1: Rational,    // NoConfidence
  q2a: Rational,   // UpdateCommittee (normal)
  q2b: Rational,   // UpdateCommittee (no confidence state)
  q4: Rational,    // TriggerHF
  q5: Rational,    // ChangePParams (security)
})
export type PoolThresholds = Schema.Schema.Type<typeof PoolThresholds>

// ────────────────────────────────────────────────────────────────────────────
// PParams — full protocol parameters (Conway era)
// Grouped by: NetworkGroup, EconomicGroup, TechnicalGroup, GovernanceGroup
// CBOR: sparse map with integer keys
// ────────────────────────────────────────────────────────────────────────────

export const PParams = Schema.Struct({
  // NetworkGroup
  maxBlockBodySize: Schema.BigInt,        // key 0
  maxTxSize: Schema.BigInt,               // key 1
  maxBlockHeaderSize: Schema.BigInt,      // key 2
  maxTxExUnits: Schema.Struct({ mem: Schema.BigInt, steps: Schema.BigInt }), // key 3 (renamed from spec)
  maxBlockExUnits: Schema.Struct({ mem: Schema.BigInt, steps: Schema.BigInt }), // key 4
  maxValSize: Schema.BigInt,              // key 5
  maxCollateralInputs: Schema.BigInt,     // key 6

  // EconomicGroup
  minFeeA: Schema.BigInt,                 // key 7 (fee coefficient)
  minFeeB: Schema.BigInt,                 // key 8 (fee constant)
  keyDeposit: Schema.BigInt,              // key 9
  poolDeposit: Schema.BigInt,             // key 10
  monetaryExpansion: Rational,            // key 11 (ρ)
  treasuryCut: Rational,                  // key 12 (τ)
  coinsPerUTxOByte: Schema.BigInt,        // key 13
  prices: Schema.Struct({                 // key 14
    memPrice: Rational,
    stepPrice: Rational,
  }),
  minFeeRefScriptCoinsPerByte: Rational,  // key 15

  // TechnicalGroup
  eMax: Schema.BigInt,                    // key 16 (max pool retirement epoch)
  nOpt: Schema.BigInt,                    // key 17 (desired number of pools)
  a0: Rational,                           // key 18 (pledge influence)
  collateralPercentage: Schema.BigInt,    // key 19
  costModels: Schema.Uint8Array,          // key 20 (opaque CBOR for now)

  // GovernanceGroup
  poolThresholds: PoolThresholds,         // key 21
  drepThresholds: DRepThresholds,         // key 22
  ccMinSize: Schema.BigInt,               // key 23
  ccMaxTermLength: Schema.BigInt,         // key 24
  govActionLifetime: Schema.BigInt,       // key 25
  govActionDeposit: Schema.BigInt,        // key 26
  drepDeposit: Schema.BigInt,             // key 27
  drepActivity: Schema.BigInt,            // key 28
})
export type PParams = Schema.Schema.Type<typeof PParams>

// ────────────────────────────────────────────────────────────────────────────
// PParamsUpdate — all fields optional (Haskell HKD StrictMaybe analog)
// Uses mapFields to wrap every field in Schema.optional
// ────────────────────────────────────────────────────────────────────────────

export const PParamsUpdate = PParams.mapFields((fields) => {
  const result: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(fields)) {
    result[key] = Schema.optional(schema as Schema.Schema<unknown>)
  }
  return result as any
})
export type PParamsUpdate = Schema.Schema.Type<typeof PParamsUpdate>
