import { describe, it, expect } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  Credential, CredentialKind, CredentialBytes,
  decodeCredential, encodeCredential,
} from "../lib/credentials.ts"

const testKeyHash = new Uint8Array(28).fill(0xaa)
const testScriptHash = new Uint8Array(28).fill(0xbb)

describe("Credential schema", () => {
  it.effect("accepts KeyHash credential", () =>
    Effect.gen(function* () {
      const cred = yield* Schema.decodeUnknownEffect(Credential)({
        _tag: CredentialKind.KeyHash,
        hash: testKeyHash,
      })
      expect(cred._tag).toBe(CredentialKind.KeyHash)
    }),
  )

  it.effect("accepts Script credential", () =>
    Effect.gen(function* () {
      const cred = yield* Schema.decodeUnknownEffect(Credential)({
        _tag: CredentialKind.Script,
        hash: testScriptHash,
      })
      expect(cred._tag).toBe(CredentialKind.Script)
    }),
  )
})

describe("Credential tagged union utilities", () => {
  it("guards narrow type", () => {
    const cred = { _tag: CredentialKind.KeyHash as const, hash: testKeyHash }
    expect(Credential.guards[CredentialKind.KeyHash](cred)).toBe(true)
    expect(Credential.guards[CredentialKind.Script](cred)).toBe(false)
  })

  it("match extracts fields", () => {
    const cred = { _tag: CredentialKind.KeyHash as const, hash: testKeyHash }
    const result = Credential.match(cred, {
      [CredentialKind.KeyHash]: (c) => "key" as const,
      [CredentialKind.Script]: (c) => "script" as const,
    })
    expect(result).toBe("key")
  })

  it("isAnyOf narrows", () => {
    const isKey = Credential.isAnyOf([CredentialKind.KeyHash])
    const cred = { _tag: CredentialKind.KeyHash as const, hash: testKeyHash }
    expect(isKey(cred)).toBe(true)
  })
})

describe("Credential CBOR round-trip", () => {
  it.effect("KeyHash round-trip", () =>
    Effect.gen(function* () {
      const original = { _tag: CredentialKind.KeyHash as const, hash: testKeyHash }
      const encoded = yield* Schema.encodeUnknownEffect(CredentialBytes)(original)
      const decoded = yield* Schema.decodeUnknownEffect(CredentialBytes)(encoded)
      expect(decoded._tag).toBe(CredentialKind.KeyHash)
      expect(decoded.hash).toEqual(testKeyHash)
    }),
  )

  it.effect("Script round-trip", () =>
    Effect.gen(function* () {
      const original = { _tag: CredentialKind.Script as const, hash: testScriptHash }
      const encoded = yield* Schema.encodeUnknownEffect(CredentialBytes)(original)
      const decoded = yield* Schema.decodeUnknownEffect(CredentialBytes)(encoded)
      expect(decoded._tag).toBe(CredentialKind.Script)
      expect(decoded.hash).toEqual(testScriptHash)
    }),
  )
})
