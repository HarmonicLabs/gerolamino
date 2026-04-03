/**
 * Protocol parameters with era-conditional fields via VariantSchema.
 *
 * Era variants: shelley, alonzo, babbage, conway
 * - Shelley: Base fields only (keys 0-12, 16-18)
 * - Alonzo:  Adds execution unit fields (keys 3-6, 13-15, 19-20)
 * - Babbage: Same as Alonzo (coinsPerUTxOByte replaces coinsPerUTxOWord)
 * - Conway:  Adds governance group (keys 21-28)
 *
 * Per-era schemas are auto-derived:
 *   PParams.shelley — only shared fields
 *   PParams.alonzo  — shared + execution units
 *   PParams.conway  — all fields (default)
 */
import { Schema } from "effect"
import * as VariantSchema from "effect/unstable/schema/VariantSchema"
import { Rational } from "./primitives.ts"

// ---------------------------------------------------------------------------
// Threshold types (Conway governance only)
// ---------------------------------------------------------------------------

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

export const PoolThresholds = Schema.Struct({
  q1: Rational,    // NoConfidence
  q2a: Rational,   // UpdateCommittee (normal)
  q2b: Rational,   // UpdateCommittee (no confidence state)
  q4: Rational,    // TriggerHF
  q5: Rational,    // ChangePParams (security)
})
export type PoolThresholds = Schema.Schema.Type<typeof PoolThresholds>

// ---------------------------------------------------------------------------
// Execution units (shared sub-schema for Alonzo+)
// ---------------------------------------------------------------------------

const ExUnitsStruct = Schema.Struct({ mem: Schema.BigInt, steps: Schema.BigInt })
const PricesStruct = Schema.Struct({ memPrice: Rational, stepPrice: Rational })

// ---------------------------------------------------------------------------
// VariantSchema setup: era variants for PParams
// ---------------------------------------------------------------------------

const PV = VariantSchema.make({
  variants: ["shelley", "alonzo", "babbage", "conway"] as const,
  defaultVariant: "conway",
})

// ---------------------------------------------------------------------------
// PParams — era-conditional protocol parameters
//
// Fields present in all eras use plain Schema types.
// Fields present only in some eras use FieldOnly/FieldExcept.
// ---------------------------------------------------------------------------

export const PParams = PV.Struct({
  // ── Shared across all eras ──────────────────────────────────────────────
  maxBlockBodySize: Schema.BigInt,        // key 0
  maxTxSize: Schema.BigInt,               // key 1
  maxBlockHeaderSize: Schema.BigInt,      // key 2
  minFeeA: Schema.BigInt,                 // key 7 (fee coefficient)
  minFeeB: Schema.BigInt,                 // key 8 (fee constant)
  keyDeposit: Schema.BigInt,              // key 9
  poolDeposit: Schema.BigInt,             // key 10
  monetaryExpansion: Rational,            // key 11 (ρ)
  treasuryCut: Rational,                  // key 12 (τ)
  eMax: Schema.BigInt,                    // key 16 (max pool retirement epoch)
  nOpt: Schema.BigInt,                    // key 17 (desired number of pools)
  a0: Rational,                           // key 18 (pledge influence)

  // ── Shelley-only fields ─────────────────────────────────────────────────
  // d (decentralization) and extraEntropy were removed in Babbage
  d: PV.FieldOnly(["shelley"])(Rational),
  extraEntropy: PV.FieldOnly(["shelley"])(Schema.Uint8Array),
  minUTxOValue: PV.FieldOnly(["shelley"])(Schema.BigInt),

  // ── Alonzo+ fields (execution units, script costs) ──────────────────────
  maxTxExUnits: PV.FieldExcept(["shelley"])(ExUnitsStruct),
  maxBlockExUnits: PV.FieldExcept(["shelley"])(ExUnitsStruct),
  maxValSize: PV.FieldExcept(["shelley"])(Schema.BigInt),
  maxCollateralInputs: PV.FieldExcept(["shelley"])(Schema.BigInt),
  coinsPerUTxOByte: PV.FieldExcept(["shelley"])(Schema.BigInt),
  prices: PV.FieldExcept(["shelley"])(PricesStruct),
  minFeeRefScriptCoinsPerByte: PV.FieldExcept(["shelley"])(Rational),
  collateralPercentage: PV.FieldExcept(["shelley"])(Schema.BigInt),
  costModels: PV.FieldExcept(["shelley"])(Schema.Uint8Array),

  // ── Conway-only fields (governance group) ───────────────────────────────
  poolThresholds: PV.FieldOnly(["conway"])(PoolThresholds),
  drepThresholds: PV.FieldOnly(["conway"])(DRepThresholds),
  ccMinSize: PV.FieldOnly(["conway"])(Schema.BigInt),
  ccMaxTermLength: PV.FieldOnly(["conway"])(Schema.BigInt),
  govActionLifetime: PV.FieldOnly(["conway"])(Schema.BigInt),
  govActionDeposit: PV.FieldOnly(["conway"])(Schema.BigInt),
  drepDeposit: PV.FieldOnly(["conway"])(Schema.BigInt),
  drepActivity: PV.FieldOnly(["conway"])(Schema.BigInt),
})

// Per-era schemas (auto-derived with caching):
//   PParams.pipe(PV.extract("shelley"))  → Schema.Struct with only Shelley fields
//   PParams.pipe(PV.extract("alonzo"))   → Schema.Struct with Shelley + Alonzo fields
//   PParams.pipe(PV.extract("conway"))   → Schema.Struct with all fields (default)

/** Shelley-era PParams schema (no execution units, no governance) */
export const ShelleyPParams = PV.extract(PParams, "shelley")
export type ShelleyPParams = Schema.Schema.Type<typeof ShelleyPParams>

/** Alonzo-era PParams schema (adds execution units) */
export const AlonzoPParams = PV.extract(PParams, "alonzo")
export type AlonzoPParams = Schema.Schema.Type<typeof AlonzoPParams>

/** Babbage-era PParams schema (same fields as Alonzo, different semantics for coinsPerUTxOByte) */
export const BabbagePParams = PV.extract(PParams, "babbage")
export type BabbagePParams = Schema.Schema.Type<typeof BabbagePParams>

/** Conway-era PParams schema (all fields including governance) */
export const ConwayPParams = PV.extract(PParams, "conway")
export type ConwayPParams = Schema.Schema.Type<typeof ConwayPParams>

// ---------------------------------------------------------------------------
// PParamsUpdate — all fields optional (for governance proposals)
// Uses the Conway variant as the base since updates can propose any field.
// ---------------------------------------------------------------------------

const opt = Schema.optional

export const PParamsUpdate = Schema.Struct({
  // Shared
  maxBlockBodySize: opt(Schema.BigInt),
  maxTxSize: opt(Schema.BigInt),
  maxBlockHeaderSize: opt(Schema.BigInt),
  minFeeA: opt(Schema.BigInt),
  minFeeB: opt(Schema.BigInt),
  keyDeposit: opt(Schema.BigInt),
  poolDeposit: opt(Schema.BigInt),
  monetaryExpansion: opt(Rational),
  treasuryCut: opt(Rational),
  eMax: opt(Schema.BigInt),
  nOpt: opt(Schema.BigInt),
  a0: opt(Rational),

  // Alonzo+
  maxTxExUnits: opt(ExUnitsStruct),
  maxBlockExUnits: opt(ExUnitsStruct),
  maxValSize: opt(Schema.BigInt),
  maxCollateralInputs: opt(Schema.BigInt),
  coinsPerUTxOByte: opt(Schema.BigInt),
  prices: opt(PricesStruct),
  minFeeRefScriptCoinsPerByte: opt(Rational),
  collateralPercentage: opt(Schema.BigInt),
  costModels: opt(Schema.Uint8Array),

  // Conway governance
  poolThresholds: opt(PoolThresholds),
  drepThresholds: opt(DRepThresholds),
  ccMinSize: opt(Schema.BigInt),
  ccMaxTermLength: opt(Schema.BigInt),
  govActionLifetime: opt(Schema.BigInt),
  govActionDeposit: opt(Schema.BigInt),
  drepDeposit: opt(Schema.BigInt),
  drepActivity: opt(Schema.BigInt),
})
export type PParamsUpdate = Schema.Schema.Type<typeof PParamsUpdate>
