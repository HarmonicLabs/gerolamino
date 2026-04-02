import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { CborSchemaFromBytes, CborKinds, type CborSchemaType } from "cbor-schema"
import type { Slot } from "./primitives.ts"
import { Bytes28 } from "./hashes.ts"

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
  | { readonly _tag: TimelockKind.RequireMOf; readonly required: number; readonly scripts: readonly TimelockType[] }
  | { readonly _tag: TimelockKind.RequireSig; readonly keyHash: Uint8Array }
  | { readonly _tag: TimelockKind.RequireTimeStart; readonly slot: bigint }
  | { readonly _tag: TimelockKind.RequireTimeExpire; readonly slot: bigint }

// Use a lazy reference for recursive schema definition
const TimelockRef = Schema.suspend((): Schema.Codec<TimelockType> => TimelockCodec)

const TimelockCodec: Schema.Codec<TimelockType> = Schema.Union([
  Schema.TaggedStruct(TimelockKind.RequireAllOf, {
    scripts: Schema.Array(TimelockRef),
  }),
  Schema.TaggedStruct(TimelockKind.RequireAnyOf, {
    scripts: Schema.Array(TimelockRef),
  }),
  Schema.TaggedStruct(TimelockKind.RequireMOf, {
    required: Schema.Number,
    scripts: Schema.Array(TimelockRef),
  }),
  Schema.TaggedStruct(TimelockKind.RequireSig, { keyHash: Bytes28 }),
  Schema.TaggedStruct(TimelockKind.RequireTimeStart, { slot: Schema.BigInt }),
  Schema.TaggedStruct(TimelockKind.RequireTimeExpire, { slot: Schema.BigInt }),
])

// Augmented with .match(), .guards, .cases, .isAnyOf()
export const Timelock = Schema.Union([
  Schema.TaggedStruct(TimelockKind.RequireAllOf, {
    scripts: Schema.Array(TimelockRef),
  }),
  Schema.TaggedStruct(TimelockKind.RequireAnyOf, {
    scripts: Schema.Array(TimelockRef),
  }),
  Schema.TaggedStruct(TimelockKind.RequireMOf, {
    required: Schema.Number,
    scripts: Schema.Array(TimelockRef),
  }),
  Schema.TaggedStruct(TimelockKind.RequireSig, { keyHash: Bytes28 }),
  Schema.TaggedStruct(TimelockKind.RequireTimeStart, { slot: Schema.BigInt }),
  Schema.TaggedStruct(TimelockKind.RequireTimeExpire, { slot: Schema.BigInt }),
]).pipe(Schema.toTaggedUnion("_tag"))

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
  Schema.TaggedStruct(ScriptKind.NativeScript, { script: TimelockCodec }),
  Schema.TaggedStruct(ScriptKind.PlutusV1, { bytes: Schema.Uint8Array }),
  Schema.TaggedStruct(ScriptKind.PlutusV2, { bytes: Schema.Uint8Array }),
  Schema.TaggedStruct(ScriptKind.PlutusV3, { bytes: Schema.Uint8Array }),
]).pipe(Schema.toTaggedUnion("_tag"))

export type Script = Schema.Schema.Type<typeof Script>

// ────────────────────────────────────────────────────────────────────────────
// Timelock CBOR decode/encode helpers
// ────────────────────────────────────────────────────────────────────────────

export function decodeTimelock(cbor: CborSchemaType): Effect.Effect<TimelockType, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Array || cbor.items.length < 1)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Timelock: expected non-empty CBOR array" }))

  const tag = cbor.items[0]
  if (tag?._tag !== CborKinds.UInt)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Timelock: expected uint tag" }))

  switch (Number(tag.num)) {
    case TimelockKind.RequireAllOf: {
      const arr = cbor.items[1]
      if (arr?._tag !== CborKinds.Array)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "RequireAllOf: expected array of scripts" }))
      return Effect.all(arr.items.map(decodeTimelock)).pipe(
        Effect.map((scripts) => ({ _tag: TimelockKind.RequireAllOf as const, scripts })),
      )
    }
    case TimelockKind.RequireAnyOf: {
      const arr = cbor.items[1]
      if (arr?._tag !== CborKinds.Array)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "RequireAnyOf: expected array of scripts" }))
      return Effect.all(arr.items.map(decodeTimelock)).pipe(
        Effect.map((scripts) => ({ _tag: TimelockKind.RequireAnyOf as const, scripts })),
      )
    }
    case TimelockKind.RequireMOf: {
      const m = cbor.items[1]
      if (m?._tag !== CborKinds.UInt)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "RequireMOf: expected uint required" }))
      const arr = cbor.items[2]
      if (arr?._tag !== CborKinds.Array)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "RequireMOf: expected array of scripts" }))
      return Effect.all(arr.items.map(decodeTimelock)).pipe(
        Effect.map((scripts) => ({ _tag: TimelockKind.RequireMOf as const, required: Number(m.num), scripts })),
      )
    }
    case TimelockKind.RequireSig: {
      const hash = cbor.items[1]
      if (hash?._tag !== CborKinds.Bytes || hash.bytes.length !== 28)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "RequireSig: expected 28-byte keyhash" }))
      return Effect.succeed({ _tag: TimelockKind.RequireSig as const, keyHash: hash.bytes })
    }
    case TimelockKind.RequireTimeStart: {
      const slot = cbor.items[1]
      if (slot?._tag !== CborKinds.UInt)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "RequireTimeStart: expected uint slot" }))
      return Effect.succeed({ _tag: TimelockKind.RequireTimeStart as const, slot: slot.num })
    }
    case TimelockKind.RequireTimeExpire: {
      const slot = cbor.items[1]
      if (slot?._tag !== CborKinds.UInt)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "RequireTimeExpire: expected uint slot" }))
      return Effect.succeed({ _tag: TimelockKind.RequireTimeExpire as const, slot: slot.num })
    }
    default:
      return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: `Timelock: unknown tag ${tag.num}` }))
  }
}

export function encodeTimelock(tl: TimelockType): CborSchemaType {
  const uint = (n: bigint | number): CborSchemaType => ({ _tag: CborKinds.UInt, num: BigInt(n) })
  const bytes = (b: Uint8Array): CborSchemaType => ({ _tag: CborKinds.Bytes, bytes: b })
  const arr = (...items: CborSchemaType[]): CborSchemaType => ({ _tag: CborKinds.Array, items })

  switch (tl._tag) {
    case TimelockKind.RequireAllOf:
      return arr(uint(0), arr(...tl.scripts.map(encodeTimelock)))
    case TimelockKind.RequireAnyOf:
      return arr(uint(1), arr(...tl.scripts.map(encodeTimelock)))
    case TimelockKind.RequireMOf:
      return arr(uint(2), uint(tl.required), arr(...tl.scripts.map(encodeTimelock)))
    case TimelockKind.RequireSig:
      return arr(uint(3), bytes(tl.keyHash))
    case TimelockKind.RequireTimeStart:
      return arr(uint(4), uint(tl.slot))
    case TimelockKind.RequireTimeExpire:
      return arr(uint(5), uint(tl.slot))
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Script CBOR decode/encode helpers
// In witness set: native scripts are bare CBOR, Plutus scripts are Tag(24, bytes)
// ────────────────────────────────────────────────────────────────────────────

export function decodeScript(cbor: CborSchemaType, kind: ScriptKind): Effect.Effect<Script, SchemaIssue.Issue> {
  if (kind === ScriptKind.NativeScript) {
    return decodeTimelock(cbor).pipe(
      Effect.map((script) => ({ _tag: ScriptKind.NativeScript as const, script }) as Script),
    )
  }
  // Plutus scripts: expect raw bytes (already unwrapped from Tag(24))
  if (cbor._tag !== CborKinds.Bytes)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: `Script(${kind}): expected CBOR bytes` }))
  return Effect.succeed({ _tag: kind, bytes: cbor.bytes } as Script)
}

export function encodeScript(script: Script): CborSchemaType {
  return Script.match(script, {
    [ScriptKind.NativeScript]: (s) => encodeTimelock(s.script),
    [ScriptKind.PlutusV1]: (s) => ({ _tag: CborKinds.Bytes, bytes: s.bytes }) as CborSchemaType,
    [ScriptKind.PlutusV2]: (s) => ({ _tag: CborKinds.Bytes, bytes: s.bytes }) as CborSchemaType,
    [ScriptKind.PlutusV3]: (s) => ({ _tag: CborKinds.Bytes, bytes: s.bytes }) as CborSchemaType,
  })
}

// ────────────────────────────────────────────────────────────────────────────
// Full CBOR codec for Timelock (standalone native script)
// ────────────────────────────────────────────────────────────────────────────

export const TimelockBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(TimelockCodec, {
    decode: SchemaGetter.transformOrFail(decodeTimelock),
    encode: SchemaGetter.transform(encodeTimelock),
  }),
)
