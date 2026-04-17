import { Effect, Option, Schema, SchemaIssue } from "effect";
import { CborKinds, type CborSchemaType } from "codecs";
import { Bytes28, Bytes32 } from "../core/hashes.ts";
import {
  expectArray,
  expectUint,
  expectBytes,
  expectText,
  expectMap,
  isNull,
  getCborSet,
  uint,
  cborBytes,
  cborText,
  arr,
  nullVal,
} from "../core/cbor-utils.ts";

// ────────────────────────────────────────────────────────────────────────────
// GovRole — who can participate in governance
// ────────────────────────────────────────────────────────────────────────────

export enum GovRole {
  CC = 0, // Constitutional Committee
  DRep = 1, // Delegate Representative
  SPO = 2, // Stake Pool Operator
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

export const VoteSchema = Schema.Enum(Vote);

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
]).pipe(Schema.toTaggedUnion("_tag"));

export type DRep = typeof DRep.Type;

export function decodeDRep(cbor: CborSchemaType): Effect.Effect<DRep, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "DRep");
    const tag = Number(yield* expectUint(items[0]!, "DRep.tag"));
    switch (tag) {
      case DRepKind.KeyHash:
        return {
          _tag: DRepKind.KeyHash as const,
          hash: yield* expectBytes(items[1]!, "DRep.hash", 28),
        };
      case DRepKind.Script:
        return {
          _tag: DRepKind.Script as const,
          hash: yield* expectBytes(items[1]!, "DRep.hash", 28),
        };
      case DRepKind.AlwaysAbstain:
        return { _tag: DRepKind.AlwaysAbstain as const };
      case DRepKind.AlwaysNoConfidence:
        return { _tag: DRepKind.AlwaysNoConfidence as const };
      default:
        return yield* Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(cbor), { message: `DRep: unknown tag ${tag}` }),
        );
    }
  });
}

export const encodeDRep = DRep.match({
  [DRepKind.KeyHash]: (d): CborSchemaType => arr(uint(0), cborBytes(d.hash)),
  [DRepKind.Script]: (d): CborSchemaType => arr(uint(1), cborBytes(d.hash)),
  [DRepKind.AlwaysAbstain]: (): CborSchemaType => arr(uint(2)),
  [DRepKind.AlwaysNoConfidence]: (): CborSchemaType => arr(uint(3)),
});

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
});
export type Voter = typeof Voter.Type;

const voterKindValues = [
  VoterKind.CCKeyHash,
  VoterKind.CCScript,
  VoterKind.DRepKeyHash,
  VoterKind.DRepScript,
  VoterKind.SPOKeyHash,
] as const;

export function decodeVoter(cbor: CborSchemaType): Effect.Effect<Voter, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "Voter", 2);
    const kindNum = Number(yield* expectUint(items[0]!, "Voter.kind"));
    const kind = voterKindValues[kindNum];
    if (kind === undefined)
      return yield* Effect.fail(
        new SchemaIssue.InvalidValue(Option.some(cbor), {
          message: `Voter: unknown kind ${kindNum}`,
        }),
      );
    const hash = yield* expectBytes(items[1]!, "Voter.hash", 28);
    return { kind, hash };
  });
}

export function encodeVoter(voter: Voter): CborSchemaType {
  return arr(uint(voter.kind), cborBytes(voter.hash));
}

// ────────────────────────────────────────────────────────────────────────────
// Anchor — [url, dataHash]
// ────────────────────────────────────────────────────────────────────────────

export const Anchor = Schema.Struct({
  url: Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
  hash: Bytes32,
});
export type Anchor = typeof Anchor.Type;

export function decodeAnchor(cbor: CborSchemaType): Effect.Effect<Anchor, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "Anchor", 2);
    const url = yield* expectText(items[0]!, "Anchor.url");
    const hash = yield* expectBytes(items[1]!, "Anchor.hash", 32);
    return { url, hash };
  });
}

export function encodeAnchor(anchor: Anchor): CborSchemaType {
  return arr(cborText(anchor.url), cborBytes(anchor.hash));
}

// ────────────────────────────────────────────────────────────────────────────
// GovActionId — [txId, index]
// ────────────────────────────────────────────────────────────────────────────

export const GovActionId = Schema.Struct({
  txId: Bytes32,
  index: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
});
export type GovActionId = typeof GovActionId.Type;

export function decodeGovActionId(
  cbor: CborSchemaType,
): Effect.Effect<GovActionId, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "GovActionId", 2);
    const txId = yield* expectBytes(items[0]!, "GovActionId.txId", 32);
    const index = yield* expectUint(items[1]!, "GovActionId.index");
    return { txId, index };
  });
}

export function encodeGovActionId(gid: GovActionId): CborSchemaType {
  return arr(cborBytes(gid.txId), uint(gid.index));
}

// ────────────────────────────────────────────────────────────────────────────
// VotingProcedure — [vote, anchor_or_null]
// ────────────────────────────────────────────────────────────────────────────

export const VotingProcedure = Schema.Struct({
  vote: Schema.Enum(Vote),
  anchor: Schema.optional(Anchor),
});
export type VotingProcedure = typeof VotingProcedure.Type;

const voteValues = [Vote.No, Vote.Yes, Vote.Abstain] as const;

export function decodeVotingProcedure(
  cbor: CborSchemaType,
): Effect.Effect<VotingProcedure, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "VotingProcedure", 2);
    const voteNum = Number(yield* expectUint(items[0]!, "VotingProcedure.vote"));
    const vote = voteValues[voteNum];
    if (vote === undefined)
      return yield* Effect.fail(
        new SchemaIssue.InvalidValue(Option.some(cbor), {
          message: `VotingProcedure: unknown vote ${voteNum}`,
        }),
      );
    const anchorCbor = items[1]!;
    if (isNull(anchorCbor)) return { vote };
    const anchor = yield* decodeAnchor(anchorCbor);
    return { vote, anchor };
  });
}

export function encodeVotingProcedure(vp: VotingProcedure): CborSchemaType {
  return arr(uint(vp.vote), vp.anchor !== undefined ? encodeAnchor(vp.anchor) : nullVal);
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
    withdrawals: Schema.Array(
      Schema.Struct({
        rewardAccount: Schema.Uint8Array,
        coin: Schema.BigInt,
      }),
    ),
    policyHash: Schema.optional(Bytes28),
  }),
  Schema.TaggedStruct(GovActionKind.NoConfidence, {
    prevActionId: Schema.optional(GovActionId),
  }),
  Schema.TaggedStruct(GovActionKind.UpdateCommittee, {
    prevActionId: Schema.optional(GovActionId),
    membersToRemove: Schema.Array(Bytes28),
    membersToAdd: Schema.Array(
      Schema.Struct({
        credential: Bytes28,
        epoch: Schema.BigInt,
      }),
    ),
    threshold: Schema.Struct({ numerator: Schema.BigInt, denominator: Schema.BigInt }),
  }),
  Schema.TaggedStruct(GovActionKind.NewConstitution, {
    prevActionId: Schema.optional(GovActionId),
    constitution: Anchor,
    policyHash: Schema.optional(Bytes28),
  }),
  Schema.TaggedStruct(GovActionKind.InfoAction, {}),
]).pipe(Schema.toTaggedUnion("_tag"));

export type GovAction = typeof GovAction.Type;

// Domain predicates via .isAnyOf()
export const needsHashProtection = GovAction.isAnyOf([
  GovActionKind.ParameterChange,
  GovActionKind.HardForkInitiation,
  GovActionKind.NoConfidence,
  GovActionKind.UpdateCommittee,
  GovActionKind.NewConstitution,
]);

export const isDelayingAction = GovAction.isAnyOf([
  GovActionKind.NoConfidence,
  GovActionKind.UpdateCommittee,
  GovActionKind.NewConstitution,
  GovActionKind.HardForkInitiation,
]);

// Actions allowed during bootstrap period (before CC/DReps are functional)
export const isBootstrapAction = GovAction.isAnyOf([
  GovActionKind.ParameterChange,
  GovActionKind.HardForkInitiation,
  GovActionKind.InfoAction,
]);

// ────────────────────────────────────────────────────────────────────────────
// GovAction CBOR encode — [tag, ...fields]
// ────────────────────────────────────────────────────────────────────────────

function encodeOptGovActionId(gid: GovActionId | undefined): CborSchemaType {
  if (gid === undefined) return nullVal;
  return encodeGovActionId(gid);
}

function encodeOptHash28(hash: Uint8Array | undefined): CborSchemaType {
  if (hash === undefined) return nullVal;
  return cborBytes(hash);
}

export const encodeGovAction = GovAction.match({
  [GovActionKind.ParameterChange]: (a): CborSchemaType =>
    arr(
      uint(GovActionKind.ParameterChange),
      encodeOptGovActionId(a.prevActionId),
      cborBytes(a.pparamsUpdate),
      encodeOptHash28(a.policyHash),
    ),
  [GovActionKind.HardForkInitiation]: (a): CborSchemaType =>
    arr(
      uint(GovActionKind.HardForkInitiation),
      encodeOptGovActionId(a.prevActionId),
      arr(uint(a.protocolVersion.major), uint(a.protocolVersion.minor)),
    ),
  [GovActionKind.TreasuryWithdrawals]: (a): CborSchemaType =>
    arr(
      uint(GovActionKind.TreasuryWithdrawals),
      {
        _tag: CborKinds.Map,
        entries: a.withdrawals.map((w) => ({
          k: cborBytes(w.rewardAccount),
          v: uint(w.coin),
        })),
      },
      encodeOptHash28(a.policyHash),
    ),
  [GovActionKind.NoConfidence]: (a): CborSchemaType =>
    arr(uint(GovActionKind.NoConfidence), encodeOptGovActionId(a.prevActionId)),
  [GovActionKind.UpdateCommittee]: (a): CborSchemaType =>
    arr(
      uint(GovActionKind.UpdateCommittee),
      encodeOptGovActionId(a.prevActionId),
      {
        _tag: CborKinds.Tag,
        tag: 258n,
        data: arr(...a.membersToRemove.map((h): CborSchemaType => cborBytes(h))),
      },
      {
        _tag: CborKinds.Map,
        entries: a.membersToAdd.map((m) => ({
          k: cborBytes(m.credential),
          v: uint(m.epoch),
        })),
      },
      {
        _tag: CborKinds.Tag,
        tag: 30n,
        data: arr(uint(a.threshold.numerator), uint(a.threshold.denominator)),
      },
    ),
  [GovActionKind.NewConstitution]: (a): CborSchemaType =>
    arr(
      uint(GovActionKind.NewConstitution),
      encodeOptGovActionId(a.prevActionId),
      encodeAnchor(a.constitution),
      encodeOptHash28(a.policyHash),
    ),
  [GovActionKind.InfoAction]: (): CborSchemaType => arr(uint(GovActionKind.InfoAction)),
});

// ────────────────────────────────────────────────────────────────────────────
// ProposalProcedure — [deposit, returnAddr, govAction, anchor]
// ────────────────────────────────────────────────────────────────────────────

export const ProposalProcedure = Schema.Struct({
  deposit: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
  returnAccount: Schema.Uint8Array, // raw reward address bytes
  govAction: GovAction,
  anchor: Anchor,
});
export type ProposalProcedure = typeof ProposalProcedure.Type;

// ────────────────────────────────────────────────────────────────────────────
// GovAction CBOR decode — [tag, ...fields]
// ────────────────────────────────────────────────────────────────────────────

function decodeOptGovActionId(
  cbor: CborSchemaType,
): Effect.Effect<GovActionId | undefined, SchemaIssue.Issue> {
  if (isNull(cbor)) return Effect.succeed(undefined);
  return decodeGovActionId(cbor);
}

function decodeOptHash28(
  cbor: CborSchemaType,
): Effect.Effect<Uint8Array | undefined, SchemaIssue.Issue> {
  if (isNull(cbor)) return Effect.succeed(undefined);
  return expectBytes(cbor, "policyHash", 28);
}

export function decodeGovAction(cbor: CborSchemaType): Effect.Effect<GovAction, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "GovAction");
    const tag = Number(yield* expectUint(items[0]!, "GovAction.tag"));
    switch (tag) {
      case GovActionKind.ParameterChange:
        return {
          _tag: GovActionKind.ParameterChange as const,
          prevActionId: yield* decodeOptGovActionId(items[1]!),
          pparamsUpdate: items[2]!._tag === CborKinds.Bytes ? items[2]!.bytes : new Uint8Array(0),
          policyHash: yield* decodeOptHash28(items[3]!),
        };
      case GovActionKind.HardForkInitiation: {
        const protVerItems = yield* expectArray(items[2]!, "ProtVer");
        return {
          _tag: GovActionKind.HardForkInitiation as const,
          prevActionId: yield* decodeOptGovActionId(items[1]!),
          protocolVersion: {
            major: yield* expectUint(protVerItems[0]!, "ProtVer.major"),
            minor: yield* expectUint(protVerItems[1]!, "ProtVer.minor"),
          },
        };
      }
      case GovActionKind.TreasuryWithdrawals: {
        const wdrlMap = yield* expectMap(items[1]!, "TreasuryWithdrawals");
        return {
          _tag: GovActionKind.TreasuryWithdrawals as const,
          withdrawals: wdrlMap.map((e) => ({
            rewardAccount: e.k._tag === CborKinds.Bytes ? e.k.bytes : new Uint8Array(0),
            coin: e.v._tag === CborKinds.UInt ? e.v.num : 0n,
          })),
          policyHash: yield* decodeOptHash28(items[2]!),
        };
      }
      case GovActionKind.NoConfidence:
        return {
          _tag: GovActionKind.NoConfidence as const,
          prevActionId: yield* decodeOptGovActionId(items[1]!),
        };
      case GovActionKind.UpdateCommittee: {
        const prevActionId = yield* decodeOptGovActionId(items[1]!);
        const removeItems = getCborSet(items[2]!) ?? [];
        const membersToRemove = [...removeItems]
          .filter(
            (i): i is Extract<CborSchemaType, { _tag: typeof CborKinds.Bytes }> =>
              i._tag === CborKinds.Bytes,
          )
          .map((i) => i.bytes);
        const addMap = yield* expectMap(items[3]!, "UpdateCommittee.add");
        const membersToAdd = addMap.map((e) => ({
          credential: e.k._tag === CborKinds.Bytes ? e.k.bytes : new Uint8Array(0),
          epoch: e.v._tag === CborKinds.UInt ? e.v.num : 0n,
        }));
        // Threshold is a rational: Tag(30, [num, den]) or bare [num, den]
        const threshCbor = items[4]!;
        const threshInner =
          threshCbor._tag === CborKinds.Tag && threshCbor.tag === 30n
            ? threshCbor.data
            : threshCbor;
        const threshArr = yield* expectArray(threshInner, "UpdateCommittee.threshold", 2);
        return {
          _tag: GovActionKind.UpdateCommittee as const,
          prevActionId,
          membersToRemove,
          membersToAdd,
          threshold: {
            numerator: yield* expectUint(threshArr[0]!, "threshold.num"),
            denominator: yield* expectUint(threshArr[1]!, "threshold.den"),
          },
        };
      }
      case GovActionKind.NewConstitution: {
        const prevActionId = yield* decodeOptGovActionId(items[1]!);
        const constitution = yield* decodeAnchor(items[2]!);
        const policyHash = items[3] ? yield* decodeOptHash28(items[3]) : undefined;
        return {
          _tag: GovActionKind.NewConstitution as const,
          prevActionId,
          constitution,
          policyHash,
        };
      }
      case GovActionKind.InfoAction:
        return { _tag: GovActionKind.InfoAction as const };
      default:
        return yield* Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(cbor), {
            message: `GovAction: unknown tag ${tag}`,
          }),
        );
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────
// ProposalProcedure CBOR decode — [deposit, returnAddr, govAction, anchor]
// ────────────────────────────────────────────────────────────────────────────

export function decodeProposalProcedure(
  cbor: CborSchemaType,
): Effect.Effect<ProposalProcedure, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "ProposalProcedure", 4);
    const deposit = yield* expectUint(items[0]!, "ProposalProcedure.deposit");
    const returnAccount = yield* expectBytes(items[1]!, "ProposalProcedure.returnAddr");
    const govAction = yield* decodeGovAction(items[2]!);
    const anchor = yield* decodeAnchor(items[3]!);
    return { deposit, returnAccount, govAction, anchor };
  });
}

export function encodeProposalProcedure(pp: ProposalProcedure): CborSchemaType {
  return arr(uint(pp.deposit), cborBytes(pp.returnAccount), encodeGovAction(pp.govAction), encodeAnchor(pp.anchor));
}

// ────────────────────────────────────────────────────────────────────────────
// VotingProcedures CBOR decode — Map<Voter, Map<GovActionId, VotingProcedure>>
// ────────────────────────────────────────────────────────────────────────────

export const VoteEntry = Schema.Struct({
  actionId: GovActionId,
  procedure: VotingProcedure,
});
export type VoteEntry = typeof VoteEntry.Type;

export const VotingProceduresEntry = Schema.Struct({
  voter: Voter,
  votes: Schema.Array(VoteEntry),
});
export type VotingProceduresEntry = typeof VotingProceduresEntry.Type;

export function decodeVotingProcedures(
  cbor: CborSchemaType,
): Effect.Effect<ReadonlyArray<VotingProceduresEntry>, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const outerEntries = yield* expectMap(cbor, "VotingProcedures");
    return yield* Effect.all(
      outerEntries.map((outer) =>
        Effect.gen(function* () {
          const voter = yield* decodeVoter(outer.k);
          const innerEntries = yield* expectMap(outer.v, "VotingProcedures.votes");
          const votes = yield* Effect.all(
            innerEntries.map((inner) =>
              Effect.gen(function* () {
                const actionId = yield* decodeGovActionId(inner.k);
                const procedure = yield* decodeVotingProcedure(inner.v);
                return { actionId, procedure };
              }),
            ),
          );
          return { voter, votes };
        }),
      ),
    );
  });
}
