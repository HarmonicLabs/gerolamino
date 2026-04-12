import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";
import { CborSchemaFromBytes, type CborSchemaType } from "cbor-schema";
import { Bytes28 } from "./hashes.ts";
import { uint, cborBytes, arr, expectArray, expectUint, expectBytes } from "./cbor-utils.ts";

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
]).pipe(Schema.toTaggedUnion("_tag"));

export type Credential = typeof Credential.Type;

// ────────────────────────────────────────────────────────────────────────────
// CBOR decode/encode helpers (used by address codec and certificate codecs)
// ────────────────────────────────────────────────────────────────────────────

export function decodeCredential(
  cbor: CborSchemaType,
): Effect.Effect<Credential, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "Credential", 2);
    const kind = Number(yield* expectUint(items[0]!, "Credential.kind"));
    const hash = yield* expectBytes(items[1]!, "Credential.hash", 28);
    switch (kind) {
      case CredentialKind.KeyHash:
        return { _tag: CredentialKind.KeyHash as const, hash };
      case CredentialKind.Script:
        return { _tag: CredentialKind.Script as const, hash };
      default:
        return yield* Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(cbor), {
            message: `Credential: unknown kind ${kind}`,
          }),
        );
    }
  });
}

export const encodeCredential = Credential.match({
  [CredentialKind.KeyHash]: (c): CborSchemaType => arr(uint(0), cborBytes(c.hash)),
  [CredentialKind.Script]: (c): CborSchemaType => arr(uint(1), cborBytes(c.hash)),
});

// ────────────────────────────────────────────────────────────────────────────
// Full CBOR codec: Uint8Array ↔ Credential
// ────────────────────────────────────────────────────────────────────────────

export const CredentialBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(Credential, {
    decode: SchemaGetter.transformOrFail(decodeCredential),
    encode: SchemaGetter.transform(encodeCredential),
  }),
);
