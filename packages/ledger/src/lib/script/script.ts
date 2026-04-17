import { Effect, Option, Schema, SchemaIssue } from "effect";
import { cborCodec, CborKinds, type CborSchemaType } from "codecs";
import type { Slot } from "../core/primitives.ts";
import { Bytes28 } from "../core/hashes.ts";
import { uint, cborBytes, arr, expectArray, expectUint, expectBytes } from "../core/cbor-utils.ts";

// ────────────────────────────────────────────────────────────────────────────
// Timelock (native script) — recursive tagged union
// CBOR: [tag, ...fields] where tag is 0-5
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

// Lazy reference for recursive schema (explicit return type breaks circular inference)
const TimelockRef = Schema.suspend((): Schema.Codec<TimelockType> => _TimelockCodec);

// Base codec — explicit Codec<TimelockType> annotation required for Schema.decodeTo
// and Schema.suspend to resolve the recursive type correctly.
const _TimelockCodec: Schema.Codec<TimelockType> = Schema.Union([
  Schema.TaggedStruct(TimelockKind.RequireAllOf, { scripts: Schema.Array(TimelockRef) }),
  Schema.TaggedStruct(TimelockKind.RequireAnyOf, { scripts: Schema.Array(TimelockRef) }),
  Schema.TaggedStruct(TimelockKind.RequireMOf, {
    required: Schema.Number,
    scripts: Schema.Array(TimelockRef),
  }),
  Schema.TaggedStruct(TimelockKind.RequireSig, { keyHash: Bytes28 }),
  Schema.TaggedStruct(TimelockKind.RequireTimeStart, { slot: Schema.BigInt }),
  Schema.TaggedStruct(TimelockKind.RequireTimeExpire, { slot: Schema.BigInt }),
]);

// Augmented with .match(), .guards, .cases, .isAnyOf() — separate Schema.Union call
// required because the explicit Codec annotation above erases the structural union
// type that toTaggedUnion needs for method generation.
export const Timelock = Schema.Union([
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
  Schema.TaggedStruct(ScriptKind.NativeScript, { script: _TimelockCodec }),
  Schema.TaggedStruct(ScriptKind.PlutusV1, { bytes: Schema.Uint8Array }),
  Schema.TaggedStruct(ScriptKind.PlutusV2, { bytes: Schema.Uint8Array }),
  Schema.TaggedStruct(ScriptKind.PlutusV3, { bytes: Schema.Uint8Array }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type Script = typeof Script.Type;

// Domain predicates
export const isPlutusScript = Script.isAnyOf([
  ScriptKind.PlutusV1,
  ScriptKind.PlutusV2,
  ScriptKind.PlutusV3,
]);

// ────────────────────────────────────────────────────────────────────────────
// CBOR encoding helpers (module-private)
// ────────────────────────────────────────────────────────────────────────────

// CBOR helpers imported from cbor-utils.ts

// ────────────────────────────────────────────────────────────────────────────
// Timelock CBOR decode/encode helpers
// ────────────────────────────────────────────────────────────────────────────

export function decodeTimelock(
  cbor: CborSchemaType,
): Effect.Effect<TimelockType, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "Timelock");
    const tag = Number(yield* expectUint(items[0]!, "Timelock.tag"));
    switch (tag) {
      case TimelockKind.RequireAllOf: {
        const children = yield* expectArray(items[1]!, "RequireAllOf.scripts");
        const scripts = yield* Effect.all(children.map(decodeTimelock));
        return { _tag: TimelockKind.RequireAllOf as const, scripts };
      }
      case TimelockKind.RequireAnyOf: {
        const children = yield* expectArray(items[1]!, "RequireAnyOf.scripts");
        const scripts = yield* Effect.all(children.map(decodeTimelock));
        return { _tag: TimelockKind.RequireAnyOf as const, scripts };
      }
      case TimelockKind.RequireMOf: {
        const required = Number(yield* expectUint(items[1]!, "RequireMOf.required"));
        const children = yield* expectArray(items[2]!, "RequireMOf.scripts");
        const scripts = yield* Effect.all(children.map(decodeTimelock));
        return { _tag: TimelockKind.RequireMOf as const, required, scripts };
      }
      case TimelockKind.RequireSig: {
        const keyHash = yield* expectBytes(items[1]!, "RequireSig.keyHash", 28);
        return { _tag: TimelockKind.RequireSig as const, keyHash };
      }
      case TimelockKind.RequireTimeStart: {
        const slot = yield* expectUint(items[1]!, "RequireTimeStart.slot");
        return { _tag: TimelockKind.RequireTimeStart as const, slot };
      }
      case TimelockKind.RequireTimeExpire: {
        const slot = yield* expectUint(items[1]!, "RequireTimeExpire.slot");
        return { _tag: TimelockKind.RequireTimeExpire as const, slot };
      }
      default:
        return yield* Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(cbor), {
            message: `Timelock: unknown tag ${tag}`,
          }),
        );
    }
  });
}

export function encodeTimelock(tl: TimelockType): CborSchemaType {
  return Timelock.match(tl, {
    [TimelockKind.RequireAllOf]: (s) => arr(uint(0), arr(...s.scripts.map(encodeTimelock))),
    [TimelockKind.RequireAnyOf]: (s) => arr(uint(1), arr(...s.scripts.map(encodeTimelock))),
    [TimelockKind.RequireMOf]: (s) =>
      arr(uint(2), uint(s.required), arr(...s.scripts.map(encodeTimelock))),
    [TimelockKind.RequireSig]: (s) => arr(uint(3), cborBytes(s.keyHash)),
    [TimelockKind.RequireTimeStart]: (s) => arr(uint(4), uint(s.slot)),
    [TimelockKind.RequireTimeExpire]: (s) => arr(uint(5), uint(s.slot)),
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Script CBOR decode/encode helpers
// In witness set: native scripts are bare CBOR, Plutus scripts are Tag(24, bytes)
// ────────────────────────────────────────────────────────────────────────────

export function decodeScript(
  cbor: CborSchemaType,
  kind: ScriptKind,
): Effect.Effect<Script, SchemaIssue.Issue> {
  if (kind === ScriptKind.NativeScript) {
    return decodeTimelock(cbor).pipe(
      Effect.map((script): Script => ({ _tag: ScriptKind.NativeScript, script })),
    );
  }
  // Plutus scripts: expect raw bytes (already unwrapped from Tag(24))
  if (cbor._tag !== CborKinds.Bytes)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), {
        message: `Script(${kind}): expected CBOR bytes`,
      }),
    );
  switch (kind) {
    case ScriptKind.PlutusV1:
      return Effect.succeed({ _tag: ScriptKind.PlutusV1, bytes: cbor.bytes });
    case ScriptKind.PlutusV2:
      return Effect.succeed({ _tag: ScriptKind.PlutusV2, bytes: cbor.bytes });
    case ScriptKind.PlutusV3:
      return Effect.succeed({ _tag: ScriptKind.PlutusV3, bytes: cbor.bytes });
  }
}

export const encodeScript = Script.match({
  [ScriptKind.NativeScript]: (s): CborSchemaType => encodeTimelock(s.script),
  [ScriptKind.PlutusV1]: (s): CborSchemaType => cborBytes(s.bytes),
  [ScriptKind.PlutusV2]: (s): CborSchemaType => cborBytes(s.bytes),
  [ScriptKind.PlutusV3]: (s): CborSchemaType => cborBytes(s.bytes),
});

// ────────────────────────────────────────────────────────────────────────────
// Full CBOR codec for Timelock (standalone native script)
// ────────────────────────────────────────────────────────────────────────────

export const TimelockBytes = cborCodec(_TimelockCodec, decodeTimelock, encodeTimelock);
