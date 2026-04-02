import { describe, it, expect } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Network } from "../lib/primitives.ts"
import { CredentialKind } from "../lib/credentials.ts"
import { Addr, AddrKind, AddrBytes, RwdAddr, RwdAddrBytes, decodeAddr, encodeAddr } from "../lib/address.ts"

const keyHash1 = new Uint8Array(28).fill(0x01)
const keyHash2 = new Uint8Array(28).fill(0x02)
const scriptHash = new Uint8Array(28).fill(0xaa)

describe("Addr schema", () => {
  it.effect("accepts base address", () =>
    Effect.gen(function* () {
      const addr = yield* Schema.decodeUnknownEffect(Addr)({
        _tag: AddrKind.Base,
        net: Network.Mainnet,
        pay: { _tag: CredentialKind.KeyHash, hash: keyHash1 },
        stake: { _tag: CredentialKind.KeyHash, hash: keyHash2 },
      })
      expect(addr._tag).toBe(AddrKind.Base)
    }),
  )

  it.effect("accepts enterprise address", () =>
    Effect.gen(function* () {
      const addr = yield* Schema.decodeUnknownEffect(Addr)({
        _tag: AddrKind.Enterprise,
        net: Network.Testnet,
        pay: { _tag: CredentialKind.Script, hash: scriptHash },
      })
      expect(addr._tag).toBe(AddrKind.Enterprise)
    }),
  )

  it.effect("accepts reward address", () =>
    Effect.gen(function* () {
      const addr = yield* Schema.decodeUnknownEffect(Addr)({
        _tag: AddrKind.Reward,
        net: Network.Mainnet,
        stake: { _tag: CredentialKind.KeyHash, hash: keyHash1 },
      })
      expect(addr._tag).toBe(AddrKind.Reward)
    }),
  )
})

describe("Addr CBOR round-trip", () => {
  it.effect("base address key/key round-trip", () =>
    Effect.gen(function* () {
      const original = {
        _tag: AddrKind.Base as const,
        net: Network.Mainnet,
        pay: { _tag: CredentialKind.KeyHash as const, hash: keyHash1 },
        stake: { _tag: CredentialKind.KeyHash as const, hash: keyHash2 },
      }
      const encoded = yield* Schema.encodeUnknownEffect(AddrBytes)(original)
      const decoded = yield* Schema.decodeUnknownEffect(AddrBytes)(encoded)
      expect(decoded._tag).toBe(AddrKind.Base)
      if (decoded._tag === AddrKind.Base) {
        expect(decoded.pay._tag).toBe(CredentialKind.KeyHash)
        expect(decoded.pay.hash).toEqual(keyHash1)
        expect(decoded.stake._tag).toBe(CredentialKind.KeyHash)
        expect(decoded.stake.hash).toEqual(keyHash2)
        expect(decoded.net).toBe(Network.Mainnet)
      }
    }),
  )

  it.effect("enterprise address script round-trip", () =>
    Effect.gen(function* () {
      const original = {
        _tag: AddrKind.Enterprise as const,
        net: Network.Testnet,
        pay: { _tag: CredentialKind.Script as const, hash: scriptHash },
      }
      const encoded = yield* Schema.encodeUnknownEffect(AddrBytes)(original)
      const decoded = yield* Schema.decodeUnknownEffect(AddrBytes)(encoded)
      expect(decoded._tag).toBe(AddrKind.Enterprise)
      if (decoded._tag === AddrKind.Enterprise) {
        expect(decoded.pay._tag).toBe(CredentialKind.Script)
        expect(decoded.pay.hash).toEqual(scriptHash)
      }
    }),
  )

  it.effect("reward address round-trip", () =>
    Effect.gen(function* () {
      const original = {
        _tag: AddrKind.Reward as const,
        net: Network.Mainnet,
        stake: { _tag: CredentialKind.KeyHash as const, hash: keyHash1 },
      }
      const encoded = yield* Schema.encodeUnknownEffect(AddrBytes)(original)
      const decoded = yield* Schema.decodeUnknownEffect(AddrBytes)(encoded)
      expect(decoded._tag).toBe(AddrKind.Reward)
      if (decoded._tag === AddrKind.Reward) {
        expect(decoded.stake.hash).toEqual(keyHash1)
      }
    }),
  )
})

describe("RwdAddr CBOR round-trip", () => {
  it.effect("reward address round-trip", () =>
    Effect.gen(function* () {
      const original = {
        net: Network.Mainnet,
        stake: { _tag: CredentialKind.KeyHash as const, hash: keyHash1 },
      }
      const encoded = yield* Schema.encodeUnknownEffect(RwdAddrBytes)(original)
      const decoded = yield* Schema.decodeUnknownEffect(RwdAddrBytes)(encoded)
      expect(decoded.net).toBe(Network.Mainnet)
      expect(decoded.stake._tag).toBe(CredentialKind.KeyHash)
      expect(decoded.stake.hash).toEqual(keyHash1)
    }),
  )
})

describe("Addr.match", () => {
  it("pattern matches address variants", () => {
    const addr = {
      _tag: AddrKind.Enterprise as const,
      net: Network.Testnet,
      pay: { _tag: CredentialKind.KeyHash as const, hash: keyHash1 },
    }
    const result = Addr.match(addr, {
      [AddrKind.Base]: () => "base",
      [AddrKind.Enterprise]: () => "enterprise",
      [AddrKind.Reward]: () => "reward",
      [AddrKind.Bootstrap]: () => "bootstrap",
    })
    expect(result).toBe("enterprise")
  })
})
