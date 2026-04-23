import {
  Effect,
  Option,
  Schema,
  SchemaAST as AST,
  SchemaIssue,
  SchemaParser,
  SchemaTransformation,
} from "effect";
import type * as FastCheck from "effect/testing/FastCheck";
import {
  cborTaggedLink,
  CborKinds,
  type CborValue,
  CborValue as CborValueSchema,
  type CborLinkFactory,
  positionalArrayLink,
  toCodecCbor,
  toCodecCborBytes,
  withCborLink,
} from "codecs";
import { Bytes28, Bytes32 } from "../core/hashes.ts";
import { cborBytes, cborMap, uint } from "../core/cbor-utils.ts";
import { MAX_WORD64, Rational } from "../core/primitives.ts";

// ────────────────────────────────────────────────────────────────────────────
// Shared numeric checks
// ────────────────────────────────────────────────────────────────────────────

const Word64BigInt = Schema.BigInt.pipe(
  Schema.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: MAX_WORD64 })),
);

const invalid = <T>(value: T, message: string): Effect.Effect<never, SchemaIssue.Issue> =>
  Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message }));

// ────────────────────────────────────────────────────────────────────────────
// GovRole — who can participate in governance
// ────────────────────────────────────────────────────────────────────────────

export enum GovRole {
  CC = 0, // Constitutional Committee
  DRep = 1, // Delegate Representative
  SPO = 2, // Stake Pool Operator
}

// ────────────────────────────────────────────────────────────────────────────
// Vote — yes | no | abstain  (CBOR: 0 | 1 | 2)
// ────────────────────────────────────────────────────────────────────────────

export enum Vote {
  No = 0,
  Yes = 1,
  Abstain = 2,
}

export const VoteSchema = Schema.Enum(Vote);

// ────────────────────────────────────────────────────────────────────────────
// DRep — delegate representative (tagged union)
// CBOR: [0, keyhash] | [1, scripthash] | [2] | [3]
// Walker auto-detects via `_tag` sentinels and emits the Cardano
// `[UInt(tag), ...fields]` Array.
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

// ────────────────────────────────────────────────────────────────────────────
// Voter — [voterKind, hash28]
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
}).pipe(withCborLink((walked) => positionalArrayLink(["kind", "hash"])(walked)));
export type Voter = typeof Voter.Type;

// ────────────────────────────────────────────────────────────────────────────
// Anchor — [url, dataHash]
// ────────────────────────────────────────────────────────────────────────────

export const Anchor = Schema.Struct({
  url: Schema.String.pipe(
    Schema.check(Schema.isMaxLength(128)),
    Schema.annotate({
      toArbitrary: () => (fc: typeof FastCheck) => fc.string({ maxLength: 128 }),
    }),
  ),
  hash: Bytes32,
}).pipe(withCborLink((walked) => positionalArrayLink(["url", "hash"])(walked)));
export type Anchor = typeof Anchor.Type;

// ────────────────────────────────────────────────────────────────────────────
// GovActionId — [txId, index]
// ────────────────────────────────────────────────────────────────────────────

export const GovActionId = Schema.Struct({
  txId: Bytes32,
  index: Word64BigInt,
}).pipe(withCborLink((walked) => positionalArrayLink(["txId", "index"])(walked)));
export type GovActionId = typeof GovActionId.Type;

// ────────────────────────────────────────────────────────────────────────────
// VotingProcedure — [vote, anchor | null]
// ────────────────────────────────────────────────────────────────────────────

export const VotingProcedure = Schema.Struct({
  vote: Schema.Enum(Vote),
  anchor: Schema.NullOr(Anchor),
}).pipe(withCborLink((walked) => positionalArrayLink(["vote", "anchor"])(walked)));
export type VotingProcedure = typeof VotingProcedure.Type;

// ────────────────────────────────────────────────────────────────────────────
// ProtocolVersion — [major, minor]
// ────────────────────────────────────────────────────────────────────────────

export const ProtocolVersion = Schema.Struct({
  major: Word64BigInt,
  minor: Word64BigInt,
}).pipe(withCborLink((walked) => positionalArrayLink(["major", "minor"])(walked)));
export type ProtocolVersion = typeof ProtocolVersion.Type;

// ────────────────────────────────────────────────────────────────────────────
// Hash28Set — Tag(258, Array<Bytes28>) (Conway nonempty-set wrapper)
// ────────────────────────────────────────────────────────────────────────────

export const Hash28Set = Schema.Array(Bytes28).pipe(
  withCborLink((walked) => cborTaggedLink(258n)(walked)),
);
export type Hash28Set = typeof Hash28Set.Type;

// ────────────────────────────────────────────────────────────────────────────
// Withdrawals — CBOR Map<Bytes(rewardAccount), UInt(coin)>
// Modeled as an array of {rewardAccount, coin} entries with a custom link.
// Declared via `Schema.declare` so the walker's Declaration branch falls
// through to `applyCustom` and attaches the hand-rolled link unchanged —
// no inner Struct objectsLink fires before it.
// ────────────────────────────────────────────────────────────────────────────

export const WithdrawalEntry = Schema.Struct({
  rewardAccount: Schema.Uint8Array,
  coin: Word64BigInt,
});
export type WithdrawalEntry = typeof WithdrawalEntry.Type;

const isWithdrawalEntry = Schema.is(WithdrawalEntry);
const isWithdrawals = (u: unknown): u is ReadonlyArray<WithdrawalEntry> =>
  Array.isArray(u) && u.every(isWithdrawalEntry);

const decodeWithdrawalEntry = (entry: { k: CborValue; v: CborValue }) =>
  CborValueSchema.guards[CborKinds.Bytes](entry.k)
    ? CborValueSchema.guards[CborKinds.UInt](entry.v)
      ? Effect.succeed({ rewardAccount: entry.k.bytes, coin: entry.v.num })
      : invalid(entry.v, "Withdrawals value must be UInt")
    : invalid(entry.k, "Withdrawals key must be Bytes");

const withdrawalsLink = new AST.Link(
  CborValueSchema.ast,
  SchemaTransformation.transformOrFail<ReadonlyArray<WithdrawalEntry>, CborValue>({
    decode: CborValueSchema.match({
      [CborKinds.Map]: (cbor) => Effect.all(cbor.entries.map(decodeWithdrawalEntry)),
      [CborKinds.UInt]: (cbor) => invalid(cbor, "Withdrawals: expected Map, got UInt"),
      [CborKinds.NegInt]: (cbor) => invalid(cbor, "Withdrawals: expected Map, got NegInt"),
      [CborKinds.Bytes]: (cbor) => invalid(cbor, "Withdrawals: expected Map, got Bytes"),
      [CborKinds.Text]: (cbor) => invalid(cbor, "Withdrawals: expected Map, got Text"),
      [CborKinds.Array]: (cbor) => invalid(cbor, "Withdrawals: expected Map, got Array"),
      [CborKinds.Tag]: (cbor) => invalid(cbor, "Withdrawals: expected Map, got Tag"),
      [CborKinds.Simple]: (cbor) => invalid(cbor, "Withdrawals: expected Map, got Simple"),
    }),
    encode: (entries) =>
      Effect.succeed(
        cborMap(
          entries.map((e) => ({
            k: cborBytes(e.rewardAccount),
            v: uint(e.coin),
          })),
        ),
      ),
  }),
);

export const Withdrawals = Schema.declare<ReadonlyArray<WithdrawalEntry>>(isWithdrawals).annotate({
  toCborLink: (): ReturnType<CborLinkFactory> => withdrawalsLink,
});

// ────────────────────────────────────────────────────────────────────────────
// CommitteeAddMap — CBOR Map<Bytes(credentialHash), UInt(epoch)>
// ────────────────────────────────────────────────────────────────────────────

export const CommitteeMember = Schema.Struct({
  credential: Schema.Uint8Array,
  epoch: Word64BigInt,
});
export type CommitteeMember = typeof CommitteeMember.Type;

const isCommitteeMember = Schema.is(CommitteeMember);
const isCommitteeAddMap = (u: unknown): u is ReadonlyArray<CommitteeMember> =>
  Array.isArray(u) && u.every(isCommitteeMember);

const decodeCommitteeMemberEntry = (entry: { k: CborValue; v: CborValue }) =>
  CborValueSchema.guards[CborKinds.Bytes](entry.k)
    ? CborValueSchema.guards[CborKinds.UInt](entry.v)
      ? Effect.succeed({ credential: entry.k.bytes, epoch: entry.v.num })
      : invalid(entry.v, "CommitteeAddMap value must be UInt")
    : invalid(entry.k, "CommitteeAddMap key must be Bytes");

const committeeAddMapLink = new AST.Link(
  CborValueSchema.ast,
  SchemaTransformation.transformOrFail<ReadonlyArray<CommitteeMember>, CborValue>({
    decode: CborValueSchema.match({
      [CborKinds.Map]: (cbor) => Effect.all(cbor.entries.map(decodeCommitteeMemberEntry)),
      [CborKinds.UInt]: (cbor) => invalid(cbor, "CommitteeAddMap: expected Map, got UInt"),
      [CborKinds.NegInt]: (cbor) => invalid(cbor, "CommitteeAddMap: expected Map, got NegInt"),
      [CborKinds.Bytes]: (cbor) => invalid(cbor, "CommitteeAddMap: expected Map, got Bytes"),
      [CborKinds.Text]: (cbor) => invalid(cbor, "CommitteeAddMap: expected Map, got Text"),
      [CborKinds.Array]: (cbor) => invalid(cbor, "CommitteeAddMap: expected Map, got Array"),
      [CborKinds.Tag]: (cbor) => invalid(cbor, "CommitteeAddMap: expected Map, got Tag"),
      [CborKinds.Simple]: (cbor) => invalid(cbor, "CommitteeAddMap: expected Map, got Simple"),
    }),
    encode: (entries) =>
      Effect.succeed(
        cborMap(
          entries.map((e) => ({
            k: cborBytes(e.credential),
            v: uint(e.epoch),
          })),
        ),
      ),
  }),
);

export const CommitteeAddMap = Schema.declare<ReadonlyArray<CommitteeMember>>(
  isCommitteeAddMap,
).annotate({ toCborLink: (): ReturnType<CborLinkFactory> => committeeAddMapLink });

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
  // PParamsUpdate encoded as opaque CBOR Bytes until protocol-params lands
  // (Phase 8). The Bytes-typed field round-trips via the default Uint8Array
  // → bytesLink fallback.
  Schema.TaggedStruct(GovActionKind.ParameterChange, {
    prevActionId: Schema.NullOr(GovActionId),
    pparamsUpdate: Schema.Uint8Array,
    policyHash: Schema.NullOr(Bytes28),
  }),
  Schema.TaggedStruct(GovActionKind.HardForkInitiation, {
    prevActionId: Schema.NullOr(GovActionId),
    protocolVersion: ProtocolVersion,
  }),
  Schema.TaggedStruct(GovActionKind.TreasuryWithdrawals, {
    withdrawals: Withdrawals,
    policyHash: Schema.NullOr(Bytes28),
  }),
  Schema.TaggedStruct(GovActionKind.NoConfidence, {
    prevActionId: Schema.NullOr(GovActionId),
  }),
  Schema.TaggedStruct(GovActionKind.UpdateCommittee, {
    prevActionId: Schema.NullOr(GovActionId),
    membersToRemove: Hash28Set,
    membersToAdd: CommitteeAddMap,
    threshold: Rational,
  }),
  Schema.TaggedStruct(GovActionKind.NewConstitution, {
    prevActionId: Schema.NullOr(GovActionId),
    constitution: Anchor,
    policyHash: Schema.NullOr(Bytes28),
  }),
  Schema.TaggedStruct(GovActionKind.InfoAction, {}),
]).pipe(Schema.toTaggedUnion("_tag"));

export type GovAction = typeof GovAction.Type;

// ────────────────────────────────────────────────────────────────────────────
// Domain predicates via `.isAnyOf()`
// ────────────────────────────────────────────────────────────────────────────

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
// ProposalProcedure — [deposit, returnAccount, govAction, anchor]
// ────────────────────────────────────────────────────────────────────────────

export const ProposalProcedure = Schema.Struct({
  deposit: Word64BigInt,
  returnAccount: Schema.Uint8Array, // raw reward address bytes
  govAction: GovAction,
  anchor: Anchor,
}).pipe(
  withCborLink((walked) =>
    positionalArrayLink(["deposit", "returnAccount", "govAction", "anchor"])(walked),
  ),
);
export type ProposalProcedure = typeof ProposalProcedure.Type;

// ────────────────────────────────────────────────────────────────────────────
// VotingProcedures — Map<Voter, Map<GovActionId, VotingProcedure>>
// The nested structure is kept as a hand-rolled Effect decoder; consumers
// (tx.ts TxBody key 19) receive `ReadonlyArray<VotingProceduresEntry>`.
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

// ────────────────────────────────────────────────────────────────────────────
// Derived CBOR codecs
// ────────────────────────────────────────────────────────────────────────────

export const DRepBytes = toCodecCborBytes(DRep);
export const DRepCbor = toCodecCbor(DRep);

export const VoterBytes = toCodecCborBytes(Voter);
export const VoterCbor = toCodecCbor(Voter);

export const AnchorBytes = toCodecCborBytes(Anchor);
export const AnchorCbor = toCodecCbor(Anchor);

export const GovActionIdBytes = toCodecCborBytes(GovActionId);
export const GovActionIdCbor = toCodecCbor(GovActionId);

export const VotingProcedureBytes = toCodecCborBytes(VotingProcedure);
export const VotingProcedureCbor = toCodecCbor(VotingProcedure);

export const GovActionBytes = toCodecCborBytes(GovAction);
export const GovActionCbor = toCodecCbor(GovAction);

export const ProposalProcedureBytes = toCodecCborBytes(ProposalProcedure);
export const ProposalProcedureCbor = toCodecCbor(ProposalProcedure);

// ────────────────────────────────────────────────────────────────────────────
// Thin shim functions — preserve the pre-Phase-4 decode/encode names used by
// tx.ts and the governance tests. Each delegates to the derived codec.
// ────────────────────────────────────────────────────────────────────────────

export const decodeDRep = (cbor: CborValue): Effect.Effect<DRep, SchemaIssue.Issue> =>
  SchemaParser.decodeEffect(DRepCbor)(cbor);

export const encodeDRep = (drep: DRep): Effect.Effect<CborValue, SchemaIssue.Issue> =>
  SchemaParser.encodeEffect(DRepCbor)(drep);

export const decodeVoter = (cbor: CborValue): Effect.Effect<Voter, SchemaIssue.Issue> =>
  SchemaParser.decodeEffect(VoterCbor)(cbor);

export const encodeVoter = (voter: Voter): Effect.Effect<CborValue, SchemaIssue.Issue> =>
  SchemaParser.encodeEffect(VoterCbor)(voter);

export const decodeAnchor = (cbor: CborValue): Effect.Effect<Anchor, SchemaIssue.Issue> =>
  SchemaParser.decodeEffect(AnchorCbor)(cbor);

export const encodeAnchor = (anchor: Anchor): Effect.Effect<CborValue, SchemaIssue.Issue> =>
  SchemaParser.encodeEffect(AnchorCbor)(anchor);

export const decodeGovActionId = (cbor: CborValue): Effect.Effect<GovActionId, SchemaIssue.Issue> =>
  SchemaParser.decodeEffect(GovActionIdCbor)(cbor);

export const encodeGovActionId = (gid: GovActionId): Effect.Effect<CborValue, SchemaIssue.Issue> =>
  SchemaParser.encodeEffect(GovActionIdCbor)(gid);

export const decodeVotingProcedure = (
  cbor: CborValue,
): Effect.Effect<VotingProcedure, SchemaIssue.Issue> =>
  SchemaParser.decodeEffect(VotingProcedureCbor)(cbor);

export const encodeVotingProcedure = (
  vp: VotingProcedure,
): Effect.Effect<CborValue, SchemaIssue.Issue> =>
  SchemaParser.encodeEffect(VotingProcedureCbor)(vp);

export const decodeGovAction = (cbor: CborValue): Effect.Effect<GovAction, SchemaIssue.Issue> =>
  SchemaParser.decodeEffect(GovActionCbor)(cbor);

export const encodeGovAction = (action: GovAction): Effect.Effect<CborValue, SchemaIssue.Issue> =>
  SchemaParser.encodeEffect(GovActionCbor)(action);

export const decodeProposalProcedure = (
  cbor: CborValue,
): Effect.Effect<ProposalProcedure, SchemaIssue.Issue> =>
  SchemaParser.decodeEffect(ProposalProcedureCbor)(cbor);

export const encodeProposalProcedure = (
  pp: ProposalProcedure,
): Effect.Effect<CborValue, SchemaIssue.Issue> =>
  SchemaParser.encodeEffect(ProposalProcedureCbor)(pp);

// ────────────────────────────────────────────────────────────────────────────
// VotingProcedures — hand-rolled Map<Voter, Map<GovActionId, VotingProcedure>>
// decoder. The nested outer-Map-of-inner-Maps shape does not map cleanly to
// a single derived Schema codec, so this stays as an Effect function.
// ────────────────────────────────────────────────────────────────────────────

const decodeVoteEntry = (inner: {
  k: CborValue;
  v: CborValue;
}): Effect.Effect<VoteEntry, SchemaIssue.Issue> =>
  Effect.all([decodeGovActionId(inner.k), decodeVotingProcedure(inner.v)] as const).pipe(
    Effect.map(([actionId, procedure]) => ({ actionId, procedure })),
  );

const decodeVotingProceduresMapEntry = (outer: {
  k: CborValue;
  v: CborValue;
}): Effect.Effect<VotingProceduresEntry, SchemaIssue.Issue> =>
  CborValueSchema.guards[CborKinds.Map](outer.v)
    ? Effect.all([
        decodeVoter(outer.k),
        Effect.all(outer.v.entries.map(decodeVoteEntry)),
      ] as const).pipe(Effect.map(([voter, votes]) => ({ voter, votes })))
    : invalid(outer.v, "VotingProcedures.votes: expected Map");

export const decodeVotingProcedures = (
  cbor: CborValue,
): Effect.Effect<ReadonlyArray<VotingProceduresEntry>, SchemaIssue.Issue> =>
  CborValueSchema.guards[CborKinds.Map](cbor)
    ? Effect.all(cbor.entries.map(decodeVotingProceduresMapEntry))
    : invalid(cbor, "VotingProcedures: expected Map");
