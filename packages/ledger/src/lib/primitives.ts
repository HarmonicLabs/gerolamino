import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { CborSchemaFromBytes, CborKinds, type CborSchemaType } from "cbor-schema"

// ────────────────────────────────────────────────────────────────────────────
// Branded numeric primitives (all non-negative bigint, CBOR: uint)
// ────────────────────────────────────────────────────────────────────────────

export const Coin = Schema.BigInt.pipe(
  Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  Schema.brand("Coin"),
)
export type Coin = Schema.Schema.Type<typeof Coin>

export const Slot = Schema.BigInt.pipe(
  Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  Schema.brand("Slot"),
)
export type Slot = Schema.Schema.Type<typeof Slot>

export const Epoch = Schema.BigInt.pipe(
  Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  Schema.brand("Epoch"),
)
export type Epoch = Schema.Schema.Type<typeof Epoch>

export const Ix = Schema.BigInt.pipe(
  Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  Schema.brand("Ix"),
)
export type Ix = Schema.Schema.Type<typeof Ix>

// ────────────────────────────────────────────────────────────────────────────
// Network enum
// ────────────────────────────────────────────────────────────────────────────

export enum Network {
  Testnet = 0,
  Mainnet = 1,
}

export const NetworkSchema = Schema.Enum(Network)
export type NetworkType = Schema.Schema.Type<typeof NetworkSchema>

// ────────────────────────────────────────────────────────────────────────────
// Rational number
// ────────────────────────────────────────────────────────────────────────────

export const Rational = Schema.Struct({
  numerator: Schema.BigInt,
  denominator: Schema.BigInt.pipe(
    Schema.check(Schema.isGreaterThanBigInt(0n)),
  ),
})
export type Rational = Schema.Schema.Type<typeof Rational>

// UnitInterval: rational in [0, 1]
export const UnitInterval = Rational
  .pipe(Schema.check(
    Schema.makeFilter<Rational>(
      (r) => r.numerator >= 0n && r.numerator <= r.denominator,
      { expected: "rational in [0, 1]" },
    ),
  ))
  .pipe(Schema.brand("UnitInterval"))
export type UnitInterval = Schema.Schema.Type<typeof UnitInterval>

// ────────────────────────────────────────────────────────────────────────────
// ExUnits (execution units: memory + CPU steps)
// ────────────────────────────────────────────────────────────────────────────

export const ExUnits = Schema.Struct({
  mem: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
  steps: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
})
export type ExUnits = Schema.Schema.Type<typeof ExUnits>

// ────────────────────────────────────────────────────────────────────────────
// CBOR Codecs
// ────────────────────────────────────────────────────────────────────────────

// Shared decode/encode for non-negative bigint ↔ CBOR uint
function decodeCborUint(cbor: CborSchemaType, context: string): Effect.Effect<bigint, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.UInt)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: `${context}: expected CBOR uint` }))
  return Effect.succeed(cbor.num)
}

function encodeBigIntToCborUint(n: bigint): CborSchemaType {
  return { _tag: CborKinds.UInt, num: n }
}

export const CoinBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Coin, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => decodeCborUint(cbor, "Coin")),
    encode: SchemaGetter.transform(encodeBigIntToCborUint),
  }),
)

export const SlotBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Slot, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => decodeCborUint(cbor, "Slot")),
    encode: SchemaGetter.transform(encodeBigIntToCborUint),
  }),
)

export const EpochBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Epoch, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => decodeCborUint(cbor, "Epoch")),
    encode: SchemaGetter.transform(encodeBigIntToCborUint),
  }),
)

export const IxBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Ix, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => decodeCborUint(cbor, "Ix")),
    encode: SchemaGetter.transform(encodeBigIntToCborUint),
  }),
)

export const NetworkBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(NetworkSchema, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => {
      if (cbor._tag !== CborKinds.UInt)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Network: expected CBOR uint" }))
      switch (Number(cbor.num)) {
        case 0: return Effect.succeed(Network.Testnet)
        case 1: return Effect.succeed(Network.Mainnet)
        default: return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: `Network: unknown value ${cbor.num}` }))
      }
    }),
    encode: SchemaGetter.transform((net: Network): CborSchemaType => ({
      _tag: CborKinds.UInt,
      num: BigInt(net),
    })),
  }),
)

// Rational: CBOR Tag(30, [numerator, denominator])
export const RationalBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Rational, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => {
      if (cbor._tag !== CborKinds.Tag || cbor.tag !== 30n)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Rational: expected CBOR Tag(30)" }))
      if (cbor.data._tag !== CborKinds.Array || cbor.data.items.length !== 2)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Rational: expected 2-element array" }))
      const [numCbor, denCbor] = cbor.data.items
      if (numCbor?._tag !== CborKinds.UInt && numCbor?._tag !== CborKinds.NegInt)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Rational: expected int numerator" }))
      if (denCbor?._tag !== CborKinds.UInt)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Rational: expected uint denominator" }))
      return Effect.succeed({
        numerator: numCbor.num,
        denominator: denCbor.num,
      })
    }),
    encode: SchemaGetter.transform((r: Rational): CborSchemaType => ({
      _tag: CborKinds.Tag,
      tag: 30n,
      data: {
        _tag: CborKinds.Array,
        items: [
          r.numerator >= 0n
            ? { _tag: CborKinds.UInt, num: r.numerator }
            : { _tag: CborKinds.NegInt, num: r.numerator },
          { _tag: CborKinds.UInt, num: r.denominator },
        ],
      },
    })),
  }),
)

// ExUnits: CBOR [mem, steps]
export const ExUnitsBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(ExUnits, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => {
      if (cbor._tag !== CborKinds.Array || cbor.items.length !== 2)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "ExUnits: expected 2-element array" }))
      const [memCbor, stepsCbor] = cbor.items
      if (memCbor?._tag !== CborKinds.UInt)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "ExUnits: expected uint mem" }))
      if (stepsCbor?._tag !== CborKinds.UInt)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "ExUnits: expected uint steps" }))
      return Effect.succeed({ mem: memCbor.num, steps: stepsCbor.num })
    }),
    encode: SchemaGetter.transform((eu: ExUnits): CborSchemaType => ({
      _tag: CborKinds.Array,
      items: [
        { _tag: CborKinds.UInt, num: eu.mem },
        { _tag: CborKinds.UInt, num: eu.steps },
      ],
    })),
  }),
)
