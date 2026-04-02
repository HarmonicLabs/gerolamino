import { describe, it, expect } from "@effect/vitest"
import { Effect } from "effect"
import { CborKinds, type CborSchemaType } from "cbor-schema"
import {
  DCert, CertKind,
  isDelegationCert, isRegistrationCert, isPoolCert, isGovernanceCert,
  decodeDCert, encodeDCert,
} from "../lib/certs.ts"
import { CredentialKind } from "../lib/credentials.ts"
import { DRepKind } from "../lib/governance.ts"

const keyHash = new Uint8Array(28).fill(0x01)
const scriptHash = new Uint8Array(28).fill(0x02)
const poolHash = new Uint8Array(28).fill(0x03)
const hash32 = new Uint8Array(32).fill(0xdd)

function cborCred(kind: number, hash: Uint8Array): CborSchemaType {
  return { _tag: CborKinds.Array, items: [{ _tag: CborKinds.UInt, num: BigInt(kind) }, { _tag: CborKinds.Bytes, bytes: hash }] }
}

describe("DCert domain predicates", () => {
  it("isDelegationCert", () => {
    expect(isDelegationCert({ _tag: CertKind.StakeDelegation, credential: { _tag: CredentialKind.KeyHash, hash: keyHash }, poolKeyHash: poolHash } as any)).toBe(true)
    expect(isDelegationCert({ _tag: CertKind.StakeRegistration, credential: { _tag: CredentialKind.KeyHash, hash: keyHash } } as any)).toBe(false)
  })

  it("isGovernanceCert", () => {
    expect(isGovernanceCert({ _tag: CertKind.RegDRep } as any)).toBe(true)
    expect(isGovernanceCert({ _tag: CertKind.PoolRegistration } as any)).toBe(false)
  })
})

describe("DCert CBOR decode/encode", () => {
  it.effect("StakeRegistration round-trip", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [{ _tag: CborKinds.UInt, num: 0n }, cborCred(0, keyHash)],
      }
      const decoded = yield* decodeDCert(cbor)
      expect(decoded._tag).toBe(CertKind.StakeRegistration)
      const reEncoded = encodeDCert(decoded)
      expect(reEncoded).toEqual(cbor)
    }),
  )

  it.effect("StakeDelegation round-trip", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: 2n },
          cborCred(0, keyHash),
          { _tag: CborKinds.Bytes, bytes: poolHash },
        ],
      }
      const decoded = yield* decodeDCert(cbor)
      expect(decoded._tag).toBe(CertKind.StakeDelegation)
      const reEncoded = encodeDCert(decoded)
      expect(reEncoded).toEqual(cbor)
    }),
  )

  it.effect("PoolRetirement round-trip", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: 4n },
          { _tag: CborKinds.Bytes, bytes: poolHash },
          { _tag: CborKinds.UInt, num: 300n },
        ],
      }
      const decoded = yield* decodeDCert(cbor)
      expect(decoded._tag).toBe(CertKind.PoolRetirement)
      if (decoded._tag === CertKind.PoolRetirement) {
        expect(decoded.epoch).toBe(300n)
      }
      const reEncoded = encodeDCert(decoded)
      expect(reEncoded).toEqual(cbor)
    }),
  )

  it.effect("VoteDeleg round-trip", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: 9n },
          cborCred(0, keyHash),
          { _tag: CborKinds.Array, items: [{ _tag: CborKinds.UInt, num: 2n }] }, // AlwaysAbstain DRep
        ],
      }
      const decoded = yield* decodeDCert(cbor)
      expect(decoded._tag).toBe(CertKind.VoteDeleg)
      if (decoded._tag === CertKind.VoteDeleg) {
        expect(decoded.drep._tag).toBe(DRepKind.AlwaysAbstain)
      }
    }),
  )

  it.effect("AuthCommitteeHot round-trip", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: 14n },
          cborCred(0, keyHash),
          cborCred(1, scriptHash),
        ],
      }
      const decoded = yield* decodeDCert(cbor)
      expect(decoded._tag).toBe(CertKind.AuthCommitteeHot)
      if (decoded._tag === CertKind.AuthCommitteeHot) {
        expect(decoded.coldCredential._tag).toBe(CredentialKind.KeyHash)
        expect(decoded.hotCredential._tag).toBe(CredentialKind.Script)
      }
      const reEncoded = encodeDCert(decoded)
      expect(reEncoded).toEqual(cbor)
    }),
  )

  it.effect("RegDRep with anchor round-trip", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Array,
        items: [
          { _tag: CborKinds.UInt, num: 16n },
          cborCred(0, keyHash),
          { _tag: CborKinds.UInt, num: 500000000n },
          { _tag: CborKinds.Array, items: [{ _tag: CborKinds.Text, text: "https://drep.example" }, { _tag: CborKinds.Bytes, bytes: hash32 }] },
        ],
      }
      const decoded = yield* decodeDCert(cbor)
      expect(decoded._tag).toBe(CertKind.RegDRep)
      if (decoded._tag === CertKind.RegDRep) {
        expect(decoded.deposit).toBe(500000000n)
        expect(decoded.anchor?.url).toBe("https://drep.example")
      }
    }),
  )
})
