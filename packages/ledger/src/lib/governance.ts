import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"
import { CborSchemaFromBytes, CborKinds, type CborSchemaType } from "cbor-schema"
import { Bytes28, Bytes32 } from "./hashes.ts"

// ────────────────────────────────────────────────────────────────────────────
// GovRole — who can participate in governance
// ────────────────────────────────────────────────────────────────────────────

export enum GovRole {
  CC = 0,      // Constitutional Committee
  DRep = 1,    // Delegate Representative
  SPO = 2,     // Stake Pool Operator
}

// ────────────────────────────────────────────────────────────────────────────
// Vote — yes | no | abstain
// CBOR: 0 | 1 | 2
// ────────────────────────────────────────────────────────────────────────────

export enum Vote {
  No = 0,
  Yes = 1,
  Abstain = 2,
}

export const VoteSchema = Schema.Enum(Vote)

// ────────────────────────────────────────────────────────────────────────────
// DRep — delegate representative
// CBOR: [0, keyhash] | [1, scripthash] | [2] | [3]
// ────────────────────────────────────────────────────────────────────────────

export enum DRepKind {
  KeyHash = 0,
  Script = 1,
  AlwaysAbstain = 2,
  AlwaysNoConfidence = 3,
}

export const DRep = Schema.Union([
  Schema.TaggedStruct(DRepKind.KeyHash, { hash: Bytes28 }),
  Schema.TaggedStruct(DRepKind.Script, { hash: Bytes28 }),
  Schema.TaggedStruct(DRepKind.AlwaysAbstain, {}),
  Schema.TaggedStruct(DRepKind.AlwaysNoConfidence, {}),
]).pipe(Schema.toTaggedUnion("_tag"))

export type DRep = Schema.Schema.Type<typeof DRep>

export function decodeDRep(cbor: CborSchemaType): Effect.Effect<DRep, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Array || cbor.items.length < 1)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "DRep: expected non-empty array" }))
  const tag = cbor.items[0]
  if (tag?._tag !== CborKinds.UInt)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "DRep: expected uint tag" }))
  switch (Number(tag.num)) {
    case 0: case 1: {
      const hash = cbor.items[1]
      if (hash?._tag !== CborKinds.Bytes || hash.bytes.length !== 28)
        return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "DRep: expected 28-byte hash" }))
      return Effect.succeed({ _tag: Number(tag.num) as DRepKind.KeyHash | DRepKind.Script, hash: hash.bytes } as DRep)
    }
    case 2: return Effect.succeed({ _tag: DRepKind.AlwaysAbstain } as DRep)
    case 3: return Effect.succeed({ _tag: DRepKind.AlwaysNoConfidence } as DRep)
    default: return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: `DRep: unknown tag ${tag.num}` }))
  }
}

export function encodeDRep(drep: DRep): CborSchemaType {
  const uint = (n: number): CborSchemaType => ({ _tag: CborKinds.UInt, num: BigInt(n) })
  return DRep.match(drep, {
    [DRepKind.KeyHash]: (d) => ({ _tag: CborKinds.Array, items: [uint(0), { _tag: CborKinds.Bytes, bytes: d.hash }] }) as CborSchemaType,
    [DRepKind.Script]: (d) => ({ _tag: CborKinds.Array, items: [uint(1), { _tag: CborKinds.Bytes, bytes: d.hash }] }) as CborSchemaType,
    [DRepKind.AlwaysAbstain]: () => ({ _tag: CborKinds.Array, items: [uint(2)] }) as CborSchemaType,
    [DRepKind.AlwaysNoConfidence]: () => ({ _tag: CborKinds.Array, items: [uint(3)] }) as CborSchemaType,
  })
}

// ────────────────────────────────────────────────────────────────────────────
// Voter — [voterKind, credential]
// CBOR: [0..4, hash28]
// Kind 0: CC keyhash, 1: CC script, 2: DRep keyhash, 3: DRep script, 4: SPO keyhash
// ────────────────────────────────────────────────────────────────────────────

export enum VoterKind {
  CCKeyHash = 0,
  CCScript = 1,
  DRepKeyHash = 2,
  DRepScript = 3,
  SPOKeyHash = 4,
}

export const Voter = Schema.Struct({
  kind: Schema.Enum(VoterKind),
  hash: Bytes28,
})
export type Voter = Schema.Schema.Type<typeof Voter>

export function decodeVoter(cbor: CborSchemaType): Effect.Effect<Voter, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Array || cbor.items.length !== 2)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Voter: expected 2-element array" }))
  const kind = cbor.items[0]
  if (kind?._tag !== CborKinds.UInt || Number(kind.num) > 4)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Voter: expected uint kind 0-4" }))
  const hash = cbor.items[1]
  if (hash?._tag !== CborKinds.Bytes || hash.bytes.length !== 28)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Voter: expected 28-byte hash" }))
  return Effect.succeed({ kind: Number(kind.num) as VoterKind, hash: hash.bytes })
}

export function encodeVoter(voter: Voter): CborSchemaType {
  return {
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.UInt, num: BigInt(voter.kind) },
      { _tag: CborKinds.Bytes, bytes: voter.hash },
    ],
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Anchor — [url, dataHash]
// ────────────────────────────────────────────────────────────────────────────

export const Anchor = Schema.Struct({
  url: Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
  hash: Bytes32,
})
export type Anchor = Schema.Schema.Type<typeof Anchor>

export function decodeAnchor(cbor: CborSchemaType): Effect.Effect<Anchor, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Array || cbor.items.length !== 2)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Anchor: expected 2-element array" }))
  const url = cbor.items[0]
  if (url?._tag !== CborKinds.Text)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Anchor: expected text url" }))
  const hash = cbor.items[1]
  if (hash?._tag !== CborKinds.Bytes || hash.bytes.length !== 32)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "Anchor: expected 32-byte hash" }))
  return Effect.succeed({ url: url.text, hash: hash.bytes })
}

export function encodeAnchor(anchor: Anchor): CborSchemaType {
  return {
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.Text, text: anchor.url },
      { _tag: CborKinds.Bytes, bytes: anchor.hash },
    ],
  }
}

// ────────────────────────────────────────────────────────────────────────────
// GovActionId — [txId, index]
// ────────────────────────────────────────────────────────────────────────────

export const GovActionId = Schema.Struct({
  txId: Bytes32,
  index: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
})
export type GovActionId = Schema.Schema.Type<typeof GovActionId>

export function decodeGovActionId(cbor: CborSchemaType): Effect.Effect<GovActionId, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Array || cbor.items.length !== 2)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "GovActionId: expected 2-element array" }))
  const txId = cbor.items[0]
  if (txId?._tag !== CborKinds.Bytes || txId.bytes.length !== 32)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "GovActionId: expected 32-byte txId" }))
  const idx = cbor.items[1]
  if (idx?._tag !== CborKinds.UInt)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "GovActionId: expected uint index" }))
  return Effect.succeed({ txId: txId.bytes, index: idx.num })
}

export function encodeGovActionId(gid: GovActionId): CborSchemaType {
  return {
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.Bytes, bytes: gid.txId },
      { _tag: CborKinds.UInt, num: gid.index },
    ],
  }
}

// ────────────────────────────────────────────────────────────────────────────
// VotingProcedure — [vote, anchor_or_null]
// ────────────────────────────────────────────────────────────────────────────

export const VotingProcedure = Schema.Struct({
  vote: Schema.Enum(Vote),
  anchor: Schema.optional(Anchor),
})
export type VotingProcedure = Schema.Schema.Type<typeof VotingProcedure>

export function decodeVotingProcedure(cbor: CborSchemaType): Effect.Effect<VotingProcedure, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Array || cbor.items.length !== 2)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "VotingProcedure: expected 2-element array" }))
  const voteCbor = cbor.items[0]
  if (voteCbor?._tag !== CborKinds.UInt || Number(voteCbor.num) > 2)
    return Effect.fail(new SchemaIssue.InvalidValue(Option.some(cbor), { message: "VotingProcedure: expected vote 0-2" }))
  const anchorCbor = cbor.items[1]
  if (anchorCbor?._tag === CborKinds.Simple && anchorCbor.value === null) {
    return Effect.succeed({ vote: Number(voteCbor.num) as Vote })
  }
  return decodeAnchor(anchorCbor!).pipe(
    Effect.map((anchor) => ({ vote: Number(voteCbor.num) as Vote, anchor })),
  )
}

export function encodeVotingProcedure(vp: VotingProcedure): CborSchemaType {
  return {
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.UInt, num: BigInt(vp.vote) },
      vp.anchor !== undefined ? encodeAnchor(vp.anchor) : { _tag: CborKinds.Simple, value: null },
    ],
  }
}

// ────────────────────────────────────────────────────────────────────────────
// GovAction — 7 variants per Conway CDDL
// ────────────────────────────────────────────────────────────────────────────

export enum GovActionKind {
  ParameterChange = 0,
  HardForkInitiation = 1,
  TreasuryWithdrawals = 2,
  NoConfidence = 3,
  UpdateCommittee = 4,
  NewConstitution = 5,
  InfoAction = 6,
}

export const GovAction = Schema.Union([
  Schema.TaggedStruct(GovActionKind.ParameterChange, {
    prevActionId: Schema.optional(GovActionId),
    // PParamsUpdate encoded as opaque bytes for now (full decode in protocol-params)
    pparamsUpdate: Schema.Uint8Array,
    policyHash: Schema.optional(Bytes28),
  }),
  Schema.TaggedStruct(GovActionKind.HardForkInitiation, {
    prevActionId: Schema.optional(GovActionId),
    protocolVersion: Schema.Struct({ major: Schema.BigInt, minor: Schema.BigInt }),
  }),
  Schema.TaggedStruct(GovActionKind.TreasuryWithdrawals, {
    withdrawals: Schema.Array(Schema.Struct({
      rewardAccount: Schema.Uint8Array,
      coin: Schema.BigInt,
    })),
    policyHash: Schema.optional(Bytes28),
  }),
  Schema.TaggedStruct(GovActionKind.NoConfidence, {
    prevActionId: Schema.optional(GovActionId),
  }),
  Schema.TaggedStruct(GovActionKind.UpdateCommittee, {
    prevActionId: Schema.optional(GovActionId),
    membersToRemove: Schema.Array(Bytes28),
    membersToAdd: Schema.Array(Schema.Struct({
      credential: Bytes28,
      epoch: Schema.BigInt,
    })),
    threshold: Schema.Struct({ numerator: Schema.BigInt, denominator: Schema.BigInt }),
  }),
  Schema.TaggedStruct(GovActionKind.NewConstitution, {
    prevActionId: Schema.optional(GovActionId),
    constitution: Anchor,
    policyHash: Schema.optional(Bytes28),
  }),
  Schema.TaggedStruct(GovActionKind.InfoAction, {}),
]).pipe(Schema.toTaggedUnion("_tag"))

export type GovAction = Schema.Schema.Type<typeof GovAction>

// Domain predicates via .isAnyOf()
export const needsHashProtection = GovAction.isAnyOf([
  GovActionKind.ParameterChange,
  GovActionKind.HardForkInitiation,
  GovActionKind.NoConfidence,
  GovActionKind.UpdateCommittee,
  GovActionKind.NewConstitution,
])

export const isDelayingAction = GovAction.isAnyOf([
  GovActionKind.NoConfidence,
  GovActionKind.UpdateCommittee,
  GovActionKind.NewConstitution,
  GovActionKind.HardForkInitiation,
])

// ────────────────────────────────────────────────────────────────────────────
// ProposalProcedure — [deposit, returnAddr, govAction, anchor]
// ────────────────────────────────────────────────────────────────────────────

export const ProposalProcedure = Schema.Struct({
  deposit: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
  returnAccount: Schema.Uint8Array, // raw reward address bytes
  govAction: GovAction,
  anchor: Anchor,
})
export type ProposalProcedure = Schema.Schema.Type<typeof ProposalProcedure>
