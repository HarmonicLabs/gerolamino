import { Effect, Option, Schema, SchemaIssue } from "effect";
import {
  CborKinds,
  type CborSchemaType,
  CborValue as CborValueSchema,
  toCodecCbor,
  toCodecCborBytes,
} from "codecs";
import { Bytes28 } from "../core/hashes.ts";
import { cborBytes } from "../core/cbor-utils.ts";

// ────────────────────────────────────────────────────────────────────────────
// Timelock (native script) — recursive tagged union
// CBOR: [tag, ...fields] where tag ∈ 0..5 (Cardano native-script convention)
// The walker auto-applies `taggedUnionLink("_tag")` because every member has
// a literal sentinel at `_tag`. Recursive reference via `Schema.suspend` with
// `Schema.Codec<TimelockType>` thunk (NOT `Schema.Schema<T>` — that would
// propagate `unknown` through `Schema.Array(Ref)` and break derivation).
// ────────────────────────────────────────────────────────────────────────────

export enum TimelockKind {
  RequireAllOf = 0,
  RequireAnyOf = 1,
  RequireMOf = 2,
  RequireSig = 3,
  RequireTimeStart = 4,
  RequireTimeExpire = 5,
}

export type TimelockType =
  | { readonly _tag: TimelockKind.RequireAllOf; readonly scripts: readonly TimelockType[] }
  | { readonly _tag: TimelockKind.RequireAnyOf; readonly scripts: readonly TimelockType[] }
  | {
      readonly _tag: TimelockKind.RequireMOf;
      readonly required: number;
      readonly scripts: readonly TimelockType[];
    }
  | { readonly _tag: TimelockKind.RequireSig; readonly keyHash: Uint8Array }
  | { readonly _tag: TimelockKind.RequireTimeStart; readonly slot: bigint }
  | { readonly _tag: TimelockKind.RequireTimeExpire; readonly slot: bigint };

const TimelockRef = Schema.suspend((): Schema.Codec<TimelockType> => _Timelock);

const _Timelock = Schema.Union([
  Schema.TaggedStruct(TimelockKind.RequireAllOf, { scripts: Schema.Array(TimelockRef) }),
  Schema.TaggedStruct(TimelockKind.RequireAnyOf, { scripts: Schema.Array(TimelockRef) }),
  Schema.TaggedStruct(TimelockKind.RequireMOf, {
    required: Schema.Number,
    scripts: Schema.Array(TimelockRef),
  }),
  Schema.TaggedStruct(TimelockKind.RequireSig, { keyHash: Bytes28 }),
  Schema.TaggedStruct(TimelockKind.RequireTimeStart, { slot: Schema.BigInt }),
  Schema.TaggedStruct(TimelockKind.RequireTimeExpire, { slot: Schema.BigInt }),
]).pipe(Schema.toTaggedUnion("_tag"));

export const Timelock = _Timelock;

// ────────────────────────────────────────────────────────────────────────────
// Derived Timelock CBOR codecs — wire shape via walker's auto-applied
// `taggedUnionLink`. `TimelockCbor` lifts CborValue ↔ Timelock; `TimelockBytes`
// composes with `CborBytes` for Uint8Array ↔ Timelock.
// ────────────────────────────────────────────────────────────────────────────

export const TimelockCbor = toCodecCbor(Timelock);

export const TimelockBytes = toCodecCborBytes(Timelock);

// ────────────────────────────────────────────────────────────────────────────
// Script types — NativeScript | PlutusV1 | PlutusV2 | PlutusV3
// ────────────────────────────────────────────────────────────────────────────

export enum ScriptKind {
  NativeScript = 0,
  PlutusV1 = 1,
  PlutusV2 = 2,
  PlutusV3 = 3,
}

export const Script = Schema.Union([
  Schema.TaggedStruct(ScriptKind.NativeScript, { script: Timelock }),
  Schema.TaggedStruct(ScriptKind.PlutusV1, { bytes: Schema.Uint8Array }),
  Schema.TaggedStruct(ScriptKind.PlutusV2, { bytes: Schema.Uint8Array }),
  Schema.TaggedStruct(ScriptKind.PlutusV3, { bytes: Schema.Uint8Array }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type Script = typeof Script.Type;

export const isPlutusScript = Script.isAnyOf([
  ScriptKind.PlutusV1,
  ScriptKind.PlutusV2,
  ScriptKind.PlutusV3,
]);

// ────────────────────────────────────────────────────────────────────────────
// Script CBOR decode/encode helpers
// In witness set: native scripts are bare CBOR, Plutus scripts are raw bytes
// (already unwrapped from the outer Tag(24) at the witness-set boundary).
// Errors from Schema.{decode,encode}Effect propagate unchanged; any callers
// that want a typed narrowing do so at the top-level entrypoint.
// ────────────────────────────────────────────────────────────────────────────

export function decodeScript(cbor: CborSchemaType, kind: ScriptKind) {
  if (kind === ScriptKind.NativeScript) {
    return Schema.decodeEffect(TimelockCbor)(cbor).pipe(
      Effect.map((script) => Script.make({ _tag: ScriptKind.NativeScript, script })),
    );
  }
  if (!CborValueSchema.guards[CborKinds.Bytes](cbor))
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), {
        message: `Script(${kind}): expected CBOR bytes`,
      }),
    );
  return Effect.succeed(Script.make({ _tag: kind, bytes: cbor.bytes }));
}

export const encodeScript = Script.match({
  [ScriptKind.NativeScript]: (s) => Schema.encodeEffect(TimelockCbor)(s.script),
  [ScriptKind.PlutusV1]: (s) => Effect.succeed(cborBytes(s.bytes)),
  [ScriptKind.PlutusV2]: (s) => Effect.succeed(cborBytes(s.bytes)),
  [ScriptKind.PlutusV3]: (s) => Effect.succeed(cborBytes(s.bytes)),
});
