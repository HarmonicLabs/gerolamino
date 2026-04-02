import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { CborKinds, type CborSchemaType } from "cbor-schema"
import { Bytes28 } from "./hashes.ts"
import { Credential, CredentialKind, decodeCredential, encodeCredential } from "./credentials.ts"
import { DRep, decodeDRep, encodeDRep } from "./governance.ts"
import { PoolParams, decodePoolParams, encodePoolParams } from "./pool.ts"
import { Anchor, decodeAnchor, encodeAnchor } from "./governance.ts"

// ────────────────────────────────────────────────────────────────────────────
// Certificate kinds — Conway era (CDDL tags 0-18)
// ────────────────────────────────────────────────────────────────────────────

export enum CertKind {
  StakeRegistration = 0,
  StakeDeregistration = 1,
  StakeDelegation = 2,
  PoolRegistration = 3,
  PoolRetirement = 4,
  // 5-6 reserved (genesis/MIR, removed in Conway)
  RegDeposit = 7,
  UnregDeposit = 8,
  VoteDeleg = 9,
  StakeVoteDeleg = 10,
  StakeRegDeleg = 11,
  VoteRegDeleg = 12,
  StakeVoteRegDeleg = 13,
  AuthCommitteeHot = 14,
  ResignCommitteeCold = 15,
  RegDRep = 16,
  UnregDRep = 17,
  UpdateDRep = 18,
}

// ────────────────────────────────────────────────────────────────────────────
// DCert — discriminated union of all certificate types
// ────────────────────────────────────────────────────────────────────────────

export const DCert = Schema.Union([
  Schema.TaggedStruct(CertKind.StakeRegistration, { credential: Credential }),
  Schema.TaggedStruct(CertKind.StakeDeregistration, { credential: Credential }),
  Schema.TaggedStruct(CertKind.StakeDelegation, { credential: Credential, poolKeyHash: Bytes28 }),
  Schema.TaggedStruct(CertKind.PoolRegistration, { poolParams: PoolParams }),
  Schema.TaggedStruct(CertKind.PoolRetirement, { poolKeyHash: Bytes28, epoch: Schema.BigInt }),
  Schema.TaggedStruct(CertKind.RegDeposit, { credential: Credential, deposit: Schema.BigInt }),
  Schema.TaggedStruct(CertKind.UnregDeposit, { credential: Credential, deposit: Schema.BigInt }),
  Schema.TaggedStruct(CertKind.VoteDeleg, { credential: Credential, drep: DRep }),
  Schema.TaggedStruct(CertKind.StakeVoteDeleg, { credential: Credential, poolKeyHash: Bytes28, drep: DRep }),
  Schema.TaggedStruct(CertKind.StakeRegDeleg, { credential: Credential, poolKeyHash: Bytes28, deposit: Schema.BigInt }),
  Schema.TaggedStruct(CertKind.VoteRegDeleg, { credential: Credential, drep: DRep, deposit: Schema.BigInt }),
  Schema.TaggedStruct(CertKind.StakeVoteRegDeleg, { credential: Credential, poolKeyHash: Bytes28, drep: DRep, deposit: Schema.BigInt }),
  Schema.TaggedStruct(CertKind.AuthCommitteeHot, { coldCredential: Credential, hotCredential: Credential }),
  Schema.TaggedStruct(CertKind.ResignCommitteeCold, { coldCredential: Credential, anchor: Schema.optional(Anchor) }),
  Schema.TaggedStruct(CertKind.RegDRep, { credential: Credential, deposit: Schema.BigInt, anchor: Schema.optional(Anchor) }),
  Schema.TaggedStruct(CertKind.UnregDRep, { credential: Credential, deposit: Schema.BigInt }),
  Schema.TaggedStruct(CertKind.UpdateDRep, { credential: Credential, anchor: Schema.optional(Anchor) }),
]).pipe(Schema.toTaggedUnion("_tag"))

export type DCert = Schema.Schema.Type<typeof DCert>

// Domain predicates
export const isDelegationCert = DCert.isAnyOf([
  CertKind.StakeDelegation,
  CertKind.VoteDeleg,
  CertKind.StakeVoteDeleg,
  CertKind.StakeRegDeleg,
  CertKind.VoteRegDeleg,
  CertKind.StakeVoteRegDeleg,
])

export const isRegistrationCert = DCert.isAnyOf([
  CertKind.StakeRegistration,
  CertKind.RegDeposit,
  CertKind.StakeRegDeleg,
  CertKind.VoteRegDeleg,
  CertKind.StakeVoteRegDeleg,
])

export const isPoolCert = DCert.isAnyOf([
  CertKind.PoolRegistration,
  CertKind.PoolRetirement,
])

export const isGovernanceCert = DCert.isAnyOf([
  CertKind.AuthCommitteeHot,
  CertKind.ResignCommitteeCold,
  CertKind.RegDRep,
  CertKind.UnregDRep,
  CertKind.UpdateDRep,
])

export const isDeregistrationCert = DCert.isAnyOf([
  CertKind.StakeDeregistration,
  CertKind.UnregDeposit,
])

export const isDRepCert = DCert.isAnyOf([
  CertKind.RegDRep,
  CertKind.UnregDRep,
  CertKind.UpdateDRep,
])

export const isCommitteeCert = DCert.isAnyOf([
  CertKind.AuthCommitteeHot,
  CertKind.ResignCommitteeCold,
])

// ────────────────────────────────────────────────────────────────────────────
// CBOR decode/encode
// CBOR: [certTag, ...fields]
// ────────────────────────────────────────────────────────────────────────────

export function decodeDCert(cbor: CborSchemaType): Effect.Effect<DCert, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Array || cbor.items.length < 1)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "DCert: expected non-empty array" }))

  const tag = cbor.items[0]
  if (tag?._tag !== CborKinds.UInt)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "DCert: expected uint tag" }))

  const tagNum = Number(tag.num)

  // Helper to extract credential at a given index
  const credAt = (idx: number) => {
    const c = cbor.items[idx]
    if (!c) return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: `DCert(${tagNum}): missing credential at ${idx}` }))
    return decodeCredential(c)
  }
  const bytesAt = (idx: number, len: number) => {
    const b = cbor.items[idx]
    if (b?._tag !== CborKinds.Bytes || b.bytes.length !== len)
      return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: `DCert(${tagNum}): expected ${len}-byte hash at ${idx}` }))
    return Effect.succeed(b.bytes)
  }
  const uintAt = (idx: number) => {
    const u = cbor.items[idx]
    if (u?._tag !== CborKinds.UInt)
      return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: `DCert(${tagNum}): expected uint at ${idx}` }))
    return Effect.succeed(u.num)
  }
  const drepAt = (idx: number) => {
    const d = cbor.items[idx]
    if (!d) return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: `DCert(${tagNum}): missing drep at ${idx}` }))
    return decodeDRep(d)
  }
  const optAnchorAt = (idx: number) => {
    const a = cbor.items[idx]
    if (!a || (a._tag === CborKinds.Simple && a.value === null)) return Effect.succeed(undefined)
    return decodeAnchor(a)
  }

  switch (tagNum) {
    case CertKind.StakeRegistration:
      return credAt(1).pipe(Effect.map((credential) => ({ _tag: CertKind.StakeRegistration as const, credential }) as DCert))
    case CertKind.StakeDeregistration:
      return credAt(1).pipe(Effect.map((credential) => ({ _tag: CertKind.StakeDeregistration as const, credential }) as DCert))
    case CertKind.StakeDelegation:
      return Effect.all({ credential: credAt(1), poolKeyHash: bytesAt(2, 28) }).pipe(
        Effect.map((r) => ({ _tag: CertKind.StakeDelegation as const, ...r }) as DCert))
    case CertKind.PoolRegistration:
      return decodePoolParams(cbor.items[1]!).pipe(
        Effect.map((poolParams) => ({ _tag: CertKind.PoolRegistration as const, poolParams }) as DCert))
    case CertKind.PoolRetirement:
      return Effect.all({ poolKeyHash: bytesAt(1, 28), epoch: uintAt(2) }).pipe(
        Effect.map((r) => ({ _tag: CertKind.PoolRetirement as const, ...r }) as DCert))
    case CertKind.RegDeposit:
      return Effect.all({ credential: credAt(1), deposit: uintAt(2) }).pipe(
        Effect.map((r) => ({ _tag: CertKind.RegDeposit as const, ...r }) as DCert))
    case CertKind.UnregDeposit:
      return Effect.all({ credential: credAt(1), deposit: uintAt(2) }).pipe(
        Effect.map((r) => ({ _tag: CertKind.UnregDeposit as const, ...r }) as DCert))
    case CertKind.VoteDeleg:
      return Effect.all({ credential: credAt(1), drep: drepAt(2) }).pipe(
        Effect.map((r) => ({ _tag: CertKind.VoteDeleg as const, ...r }) as DCert))
    case CertKind.StakeVoteDeleg:
      return Effect.all({ credential: credAt(1), poolKeyHash: bytesAt(2, 28), drep: drepAt(3) }).pipe(
        Effect.map((r) => ({ _tag: CertKind.StakeVoteDeleg as const, ...r }) as DCert))
    case CertKind.StakeRegDeleg:
      return Effect.all({ credential: credAt(1), poolKeyHash: bytesAt(2, 28), deposit: uintAt(3) }).pipe(
        Effect.map((r) => ({ _tag: CertKind.StakeRegDeleg as const, ...r }) as DCert))
    case CertKind.VoteRegDeleg:
      return Effect.all({ credential: credAt(1), drep: drepAt(2), deposit: uintAt(3) }).pipe(
        Effect.map((r) => ({ _tag: CertKind.VoteRegDeleg as const, ...r }) as DCert))
    case CertKind.StakeVoteRegDeleg:
      return Effect.all({ credential: credAt(1), poolKeyHash: bytesAt(2, 28), drep: drepAt(3), deposit: uintAt(4) }).pipe(
        Effect.map((r) => ({ _tag: CertKind.StakeVoteRegDeleg as const, ...r }) as DCert))
    case CertKind.AuthCommitteeHot:
      return Effect.all({ coldCredential: credAt(1), hotCredential: credAt(2) }).pipe(
        Effect.map((r) => ({ _tag: CertKind.AuthCommitteeHot as const, ...r }) as DCert))
    case CertKind.ResignCommitteeCold:
      return Effect.all({ coldCredential: credAt(1), anchor: optAnchorAt(2) }).pipe(
        Effect.map((r) => ({ _tag: CertKind.ResignCommitteeCold as const, ...r }) as DCert))
    case CertKind.RegDRep:
      return Effect.all({ credential: credAt(1), deposit: uintAt(2), anchor: optAnchorAt(3) }).pipe(
        Effect.map((r) => ({ _tag: CertKind.RegDRep as const, ...r }) as DCert))
    case CertKind.UnregDRep:
      return Effect.all({ credential: credAt(1), deposit: uintAt(2) }).pipe(
        Effect.map((r) => ({ _tag: CertKind.UnregDRep as const, ...r }) as DCert))
    case CertKind.UpdateDRep:
      return Effect.all({ credential: credAt(1), anchor: optAnchorAt(2) }).pipe(
        Effect.map((r) => ({ _tag: CertKind.UpdateDRep as const, ...r }) as DCert))
    default:
      return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: `DCert: unknown tag ${tagNum}` }))
  }
}

const uint = (n: bigint | number): CborSchemaType => ({ _tag: CborKinds.UInt, num: BigInt(n) })
const nullVal: CborSchemaType = { _tag: CborKinds.Simple, value: null }
const arr = (...items: CborSchemaType[]): CborSchemaType => ({ _tag: CborKinds.Array, items })

export const encodeDCert = DCert.match({
  [CertKind.StakeRegistration]: (c): CborSchemaType => arr(uint(0), encodeCredential(c.credential)),
  [CertKind.StakeDeregistration]: (c): CborSchemaType => arr(uint(1), encodeCredential(c.credential)),
  [CertKind.StakeDelegation]: (c): CborSchemaType => arr(uint(2), encodeCredential(c.credential), { _tag: CborKinds.Bytes, bytes: c.poolKeyHash }),
  [CertKind.PoolRegistration]: (c): CborSchemaType => arr(uint(3), encodePoolParams(c.poolParams)),
  [CertKind.PoolRetirement]: (c): CborSchemaType => arr(uint(4), { _tag: CborKinds.Bytes, bytes: c.poolKeyHash }, uint(c.epoch)),
  [CertKind.RegDeposit]: (c): CborSchemaType => arr(uint(7), encodeCredential(c.credential), uint(c.deposit)),
  [CertKind.UnregDeposit]: (c): CborSchemaType => arr(uint(8), encodeCredential(c.credential), uint(c.deposit)),
  [CertKind.VoteDeleg]: (c): CborSchemaType => arr(uint(9), encodeCredential(c.credential), encodeDRep(c.drep)),
  [CertKind.StakeVoteDeleg]: (c): CborSchemaType => arr(uint(10), encodeCredential(c.credential), { _tag: CborKinds.Bytes, bytes: c.poolKeyHash }, encodeDRep(c.drep)),
  [CertKind.StakeRegDeleg]: (c): CborSchemaType => arr(uint(11), encodeCredential(c.credential), { _tag: CborKinds.Bytes, bytes: c.poolKeyHash }, uint(c.deposit)),
  [CertKind.VoteRegDeleg]: (c): CborSchemaType => arr(uint(12), encodeCredential(c.credential), encodeDRep(c.drep), uint(c.deposit)),
  [CertKind.StakeVoteRegDeleg]: (c): CborSchemaType => arr(uint(13), encodeCredential(c.credential), { _tag: CborKinds.Bytes, bytes: c.poolKeyHash }, encodeDRep(c.drep), uint(c.deposit)),
  [CertKind.AuthCommitteeHot]: (c): CborSchemaType => arr(uint(14), encodeCredential(c.coldCredential), encodeCredential(c.hotCredential)),
  [CertKind.ResignCommitteeCold]: (c): CborSchemaType => arr(uint(15), encodeCredential(c.coldCredential), c.anchor !== undefined ? encodeAnchor(c.anchor) : nullVal),
  [CertKind.RegDRep]: (c): CborSchemaType => arr(uint(16), encodeCredential(c.credential), uint(c.deposit), c.anchor !== undefined ? encodeAnchor(c.anchor) : nullVal),
  [CertKind.UnregDRep]: (c): CborSchemaType => arr(uint(17), encodeCredential(c.credential), uint(c.deposit)),
  [CertKind.UpdateDRep]: (c): CborSchemaType => arr(uint(18), encodeCredential(c.credential), c.anchor !== undefined ? encodeAnchor(c.anchor) : nullVal),
})
