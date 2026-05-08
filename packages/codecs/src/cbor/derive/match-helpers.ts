/**
 * Shared helpers for `CborValueSchema.match(...)` case sets in derive
 * Links. Every Link discriminates on `CborValue._tag`; the same
 * "fail-on-unexpected-kinds" boilerplate appears in every Link with
 * only the `expected` label varying. Centralised here so a change to
 * the error message format (or to `SchemaIssue.InvalidValue`) lands in
 * one place.
 */
import { Effect, Option, SchemaIssue } from "effect";
import { CborKinds, type CborValue } from "../CborValue.ts";

/** Wrap an off-shape CborValue into a typed `SchemaIssue.InvalidValue`
 *  failure. Used by every Link's `decodeTo` body. */
export const invalid = <T>(value: T, message: string): Effect.Effect<never, SchemaIssue.InvalidValue> =>
  Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message }));

/**
 * Build a case-set for `CborValueSchema.match` where every kind fails
 * with a descriptive error. Callers spread this into their match and
 * override the accepted kinds:
 *
 *     CborValueSchema.match({
 *       ...failOthers("Map for Struct"),
 *       [CborKinds.Map]: (v) => decodeMap(v),
 *     })
 */
export const failOthers = (expected: string) =>
  ({
    [CborKinds.UInt]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got UInt`),
    [CborKinds.NegInt]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got NegInt`),
    [CborKinds.Bytes]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Bytes`),
    [CborKinds.Text]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Text`),
    [CborKinds.Array]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Array`),
    [CborKinds.Map]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Map`),
    [CborKinds.Tag]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Tag`),
    [CborKinds.Simple]: (v: CborValue) => invalid(v, `Expected CBOR ${expected}, got Simple`),
  }) as const;
