import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { CborSchemaFromBytes, CborKinds, type CborSchemaType } from "cbor-schema"
import { Bytes28 } from "./hashes.ts"

// ────────────────────────────────────────────────────────────────────────────
// Credential — KeyHash | Script discriminated union
// CBOR: [0, keyhash] | [1, scripthash]
// Both variants carry a 28-byte hash (checked via Bytes28 schema).
// ────────────────────────────────────────────────────────────────────────────

export enum CredentialKind {
  KeyHash = 0,
  Script = 1,
}

export const Credential = Schema.Union([
  Schema.TaggedStruct(CredentialKind.KeyHash, { hash: Bytes28 }),
  Schema.TaggedStruct(CredentialKind.Script, { hash: Bytes28 }),
]).pipe(Schema.toTaggedUnion("_tag"))

export type Credential = Schema.Schema.Type<typeof Credential>

// ────────────────────────────────────────────────────────────────────────────
// CBOR decode/encode helpers (used by address codec and certificate codecs)
// ────────────────────────────────────────────────────────────────────────────

export function decodeCredential(cbor: CborSchemaType): Effect.Effect<Credential, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Array || cbor.items.length !== 2)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Credential: expected 2-element CBOR array" }))
  const kind = cbor.items[0]
  if (kind?._tag !== CborKinds.UInt)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Credential: expected uint tag" }))
  const hash = cbor.items[1]
  if (hash?._tag !== CborKinds.Bytes || hash.bytes.length !== 28)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Credential: expected 28-byte hash" }))
  switch (Number(kind.num)) {
    case 0: return Effect.succeed({ _tag: CredentialKind.KeyHash as const, hash: hash.bytes } as Credential)
    case 1: return Effect.succeed({ _tag: CredentialKind.Script as const, hash: hash.bytes } as Credential)
    default: return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: `Credential: unknown kind ${kind.num}` }))
  }
}

export const encodeCredential = Credential.match({
  [CredentialKind.KeyHash]: (c): CborSchemaType => ({
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.UInt, num: 0n },
      { _tag: CborKinds.Bytes, bytes: c.hash },
    ],
  }),
  [CredentialKind.Script]: (c): CborSchemaType => ({
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.UInt, num: 1n },
      { _tag: CborKinds.Bytes, bytes: c.hash },
    ],
  }),
})

// ────────────────────────────────────────────────────────────────────────────
// Full CBOR codec: Uint8Array ↔ Credential
// ────────────────────────────────────────────────────────────────────────────

export const CredentialBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Credential, {
    decode: SchemaGetter.transformOrFail(decodeCredential),
    encode: SchemaGetter.transform(
      Credential.match({
        [CredentialKind.KeyHash]: (c): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [
            { _tag: CborKinds.UInt, num: 0n },
            { _tag: CborKinds.Bytes, bytes: c.hash },
          ],
        }),
        [CredentialKind.Script]: (c): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [
            { _tag: CborKinds.UInt, num: 1n },
            { _tag: CborKinds.Bytes, bytes: c.hash },
          ],
        }),
      }),
    ),
  }),
)
