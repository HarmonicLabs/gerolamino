import { describe, it, expect } from "@effect/vitest"
import { Effect, Schema } from "effect"
import {
  Hash28, Hash32, Signature,
  KeyHash, ScriptHash, PolicyId, TxId, DataHash,
  Hash28Bytes, Hash32Bytes, TxIdBytes,
  Bytes28, Bytes32,
} from "../lib/hashes.ts"

describe("Hash28 schema", () => {
  it.effect("accepts 28-byte Uint8Array", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(28).fill(0xab)
      const hash = yield* Schema.decodeUnknownEffect(Hash28)(bytes)
      expect(hash.length).toBe(28)
    }),
  )

  it.effect("rejects wrong length", () =>
    Effect.gen(function* () {
      const exit = yield* Schema.decodeUnknownEffect(Hash28)(new Uint8Array(27)).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )
})

describe("Hash32 schema", () => {
  it.effect("accepts 32-byte Uint8Array", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(32).fill(0xcd)
      const hash = yield* Schema.decodeUnknownEffect(Hash32)(bytes)
      expect(hash.length).toBe(32)
    }),
  )

  it.effect("rejects wrong length", () =>
    Effect.gen(function* () {
      const exit = yield* Schema.decodeUnknownEffect(Hash32)(new Uint8Array(31)).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )
})

describe("Signature schema", () => {
  it.effect("accepts 64-byte Uint8Array", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(64).fill(0xef)
      const sig = yield* Schema.decodeUnknownEffect(Signature)(bytes)
      expect(sig.length).toBe(64)
    }),
  )
})

describe("Stacked brands", () => {
  it.effect("KeyHash is a Hash28 subtype", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(28).fill(0x01)
      const kh = yield* Schema.decodeUnknownEffect(KeyHash)(bytes)
      expect(kh.length).toBe(28)
    }),
  )

  it.effect("TxId is a Hash32 subtype", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(32).fill(0x02)
      const txId = yield* Schema.decodeUnknownEffect(TxId)(bytes)
      expect(txId.length).toBe(32)
    }),
  )
})

describe("Bytes28 / Bytes32 (unbranded checked)", () => {
  it.effect("Bytes28 rejects wrong length", () =>
    Effect.gen(function* () {
      const exit = yield* Schema.decodeUnknownEffect(Bytes28)(new Uint8Array(10)).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("Bytes32 accepts correct length", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(32).fill(0xff)
      const result = yield* Schema.decodeUnknownEffect(Bytes32)(bytes)
      expect(result.length).toBe(32)
    }),
  )
})

describe("Hash CBOR round-trip", () => {
  it.effect("Hash28 round-trip", () =>
    Effect.gen(function* () {
      const original = new Uint8Array(28).fill(0xaa)
      const encoded = yield* Schema.encodeUnknownEffect(Hash28Bytes)(original)
      const decoded = yield* Schema.decodeUnknownEffect(Hash28Bytes)(encoded)
      expect(decoded).toEqual(original)
    }),
  )

  it.effect("Hash32 round-trip", () =>
    Effect.gen(function* () {
      const original = new Uint8Array(32).fill(0xbb)
      const encoded = yield* Schema.encodeUnknownEffect(Hash32Bytes)(original)
      const decoded = yield* Schema.decodeUnknownEffect(Hash32Bytes)(encoded)
      expect(decoded).toEqual(original)
    }),
  )

  it.effect("TxId round-trip", () =>
    Effect.gen(function* () {
      const original = new Uint8Array(32).fill(0xcc)
      const encoded = yield* Schema.encodeUnknownEffect(TxIdBytes)(original)
      const decoded = yield* Schema.decodeUnknownEffect(TxIdBytes)(encoded)
      expect(decoded).toEqual(original)
    }),
  )
})
