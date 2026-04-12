import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";
import { CborSchemaFromBytes, CborKinds, type CborSchemaType } from "cbor-schema";
import { expectUint, expectInt, expectArray, expectTag, uint, negInt, arr } from "./cbor-utils.ts";

// ────────────────────────────────────────────────────────────────────────────
// Branded numeric primitives (all non-negative bigint, CBOR: uint)
// ────────────────────────────────────────────────────────────────────────────

export const Coin = Schema.BigInt.pipe(
  Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  Schema.brand("Coin"),
);
export type Coin = typeof Coin.Type;

export const Slot = Schema.BigInt.pipe(
  Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  Schema.brand("Slot"),
);
export type Slot = typeof Slot.Type;

export const Epoch = Schema.BigInt.pipe(
  Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  Schema.brand("Epoch"),
);
export type Epoch = typeof Epoch.Type;

export const Ix = Schema.BigInt.pipe(
  Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  Schema.brand("Ix"),
);
export type Ix = typeof Ix.Type;

// ────────────────────────────────────────────────────────────────────────────
// Network enum
// ────────────────────────────────────────────────────────────────────────────

export enum Network {
  Testnet = 0,
  Mainnet = 1,
}

export const NetworkSchema = Schema.Enum(Network);
export type NetworkType = typeof NetworkSchema.Type;

// ────────────────────────────────────────────────────────────────────────────
// Rational number
// ────────────────────────────────────────────────────────────────────────────

export const Rational = Schema.Struct({
  numerator: Schema.BigInt,
  denominator: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanBigInt(0n))),
});
export type Rational = typeof Rational.Type;

// UnitInterval: rational in [0, 1]
export const UnitInterval = Rational.pipe(
  Schema.check(
    Schema.makeFilter<Rational>((r) => r.numerator >= 0n && r.numerator <= r.denominator, {
      expected: "rational in [0, 1]",
    }),
  ),
).pipe(Schema.brand("UnitInterval"));
export type UnitInterval = typeof UnitInterval.Type;

// ────────────────────────────────────────────────────────────────────────────
// ExUnits (execution units: memory + CPU steps)
// ────────────────────────────────────────────────────────────────────────────

export const ExUnits = Schema.Struct({
  mem: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
  steps: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
});
export type ExUnits = typeof ExUnits.Type;

// ────────────────────────────────────────────────────────────────────────────
// CBOR Codecs
// ────────────────────────────────────────────────────────────────────────────

export const CoinBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Coin, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => expectUint(cbor, "Coin")),
    encode: SchemaGetter.transform(uint),
  }),
);

export const SlotBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Slot, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => expectUint(cbor, "Slot")),
    encode: SchemaGetter.transform(uint),
  }),
);

export const EpochBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Epoch, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => expectUint(cbor, "Epoch")),
    encode: SchemaGetter.transform(uint),
  }),
);

export const IxBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Ix, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) => expectUint(cbor, "Ix")),
    encode: SchemaGetter.transform(uint),
  }),
);

export const NetworkBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(NetworkSchema, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) =>
      Effect.gen(function* () {
        const n = Number(yield* expectUint(cbor, "Network"));
        switch (n) {
          case Network.Testnet:
            return Network.Testnet;
          case Network.Mainnet:
            return Network.Mainnet;
          default:
            return yield* Effect.fail(
              new SchemaIssue.InvalidValue(Option.some(cbor), {
                message: `Network: unknown value ${n}`,
              }),
            );
        }
      }),
    ),
    encode: SchemaGetter.transform((net: Network): CborSchemaType => uint(net)),
  }),
);

// Rational: CBOR Tag(30, [numerator, denominator])
export const RationalBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Rational, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) =>
      Effect.gen(function* () {
        const data = yield* expectTag(cbor, "Rational", 30n);
        const items = yield* expectArray(data, "Rational", 2);
        const numerator = yield* expectInt(items[0]!, "Rational.numerator");
        const denominator = yield* expectUint(items[1]!, "Rational.denominator");
        return { numerator, denominator };
      }),
    ),
    encode: SchemaGetter.transform(
      (r: Rational): CborSchemaType => ({
        _tag: CborKinds.Tag,
        tag: 30n,
        data: arr(
          r.numerator >= 0n ? uint(r.numerator) : negInt(r.numerator),
          uint(r.denominator),
        ),
      }),
    ),
  }),
);

// ExUnits: CBOR [mem, steps]
export const ExUnitsBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(ExUnits, {
    decode: SchemaGetter.transformOrFail((cbor: CborSchemaType) =>
      Effect.gen(function* () {
        const items = yield* expectArray(cbor, "ExUnits", 2);
        return {
          mem: yield* expectUint(items[0]!, "ExUnits.mem"),
          steps: yield* expectUint(items[1]!, "ExUnits.steps"),
        };
      }),
    ),
    encode: SchemaGetter.transform(
      (eu: ExUnits): CborSchemaType => arr(uint(eu.mem), uint(eu.steps)),
    ),
  }),
);
