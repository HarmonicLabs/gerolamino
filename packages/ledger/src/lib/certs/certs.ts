import {
  Effect,
  Option,
  Schema,
  SchemaAST as AST,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import {
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
import { cborMap, negInt, uint } from "../core/cbor-utils.ts";
import { Credential, CredentialCbor } from "../core/credentials.ts";
import { Anchor, DRep } from "../governance/governance.ts";
import { MAX_WORD64, UnitInterval } from "../core/primitives.ts";
import { PoolMetadata, Relay, RewardAccount } from "../pool/pool.ts";

const Word64BigInt = Schema.BigInt.pipe(
  Schema.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: MAX_WORD64 })),
);

// ────────────────────────────────────────────────────────────────────────────
// Certificate kinds — Conway era (CDDL tags 0-18)
// ────────────────────────────────────────────────────────────────────────────

export enum CertKind {
  StakeRegistration = 0,
  StakeDeregistration = 1,
  StakeDelegation = 2,
  PoolRegistration = 3,
  PoolRetirement = 4,
  GenesisKeyDelegation = 5, // deprecated post-Conway
  MoveInstantRewards = 6, // deprecated post-Conway
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
// MIRTarget — shape-discriminated (not tag-discriminated) Union.
// CBOR wire: UInt(coin) for the bare-coin variant; Map<Credential, Coin> for
// the per-credential variant. Since the two arms are distinguished only by
// outer CBOR major type, we attach a custom `toCborLink` that dispatches on
// the observed CborValue shape and round-trips each arm manually.
// ────────────────────────────────────────────────────────────────────────────

// CDDL: bare `coin = uint` (non-negative, Word64); map variant values are
// `delta_coin = int` (signed int64 — pool-deposit slashing can be negative).
const NonNegBigInt = Schema.BigInt.pipe(
  Schema.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: MAX_WORD64 })),
);
const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;
const DeltaCoin = Schema.BigInt.pipe(
  Schema.check(Schema.isBetweenBigInt({ minimum: MIN_INT64, maximum: MAX_INT64 })),
);

const signedBigIntToCbor = (n: bigint): CborValue => (n >= 0n ? uint(n) : negInt(n));

const isSignedCborInt = CborValueSchema.isAnyOf([CborKinds.UInt, CborKinds.NegInt]);

const invalid = <T>(value: T, message: string): Effect.Effect<never, SchemaIssue.Issue> =>
  Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message }));

const decodeMIRMapEntry = (entry: { k: CborValue; v: CborValue }) =>
  Schema.decodeEffect(CredentialCbor)(entry.k).pipe(
    Effect.mapError((e) => e.issue),
    Effect.flatMap((credential) =>
      isSignedCborInt(entry.v)
        ? Effect.succeed({ credential, coin: entry.v.num })
        : invalid(entry.v, "MIRTarget.map: delta_coin entry must be UInt or NegInt"),
    ),
  );

const encodeMIRMapEntry = (e: { credential: typeof Credential.Type; coin: bigint }) =>
  Schema.encodeEffect(CredentialCbor)(e.credential).pipe(
    Effect.mapError((err) => err.issue),
    Effect.map((k) => ({ k, v: signedBigIntToCbor(e.coin) })),
  );

// Internal binding: tagged-union-augmented base (exposes `.cases`/`.match`/
// `.guards`/`.isAnyOf`). Referenced inside the `withCborLink` callback where
// `MIRTarget` itself is still mid-assignment and not yet fully typed.
const MIRTargetBase = Schema.Union([
  Schema.TaggedStruct("coin" as const, { value: NonNegBigInt }),
  Schema.TaggedStruct("map" as const, {
    entries: Schema.Array(Schema.Struct({ credential: Credential, coin: DeltaCoin })),
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type MIRTarget = typeof MIRTargetBase.Type;

export const MIRTarget = MIRTargetBase.pipe(
  withCborLink(
    (): ReturnType<CborLinkFactory> =>
      new AST.Link(
        CborValueSchema.ast,
        SchemaTransformation.transformOrFail<MIRTarget, CborValue>({
          decode: CborValueSchema.match({
            [CborKinds.UInt]: (cbor) =>
              Effect.succeed(MIRTargetBase.cases.coin.make({ value: cbor.num })),
            [CborKinds.Map]: (cbor) =>
              Effect.all(cbor.entries.map(decodeMIRMapEntry)).pipe(
                Effect.map((entries) => MIRTargetBase.cases.map.make({ entries })),
              ),
            [CborKinds.NegInt]: (cbor) =>
              invalid(cbor, "MIRTarget.coin: bare coin must be UInt (non-negative)"),
            [CborKinds.Bytes]: (cbor) => invalid(cbor, "MIRTarget: Bytes not allowed"),
            [CborKinds.Text]: (cbor) => invalid(cbor, "MIRTarget: Text not allowed"),
            [CborKinds.Array]: (cbor) => invalid(cbor, "MIRTarget: Array not allowed"),
            [CborKinds.Tag]: (cbor) => invalid(cbor, "MIRTarget: Tag not allowed"),
            [CborKinds.Simple]: (cbor) => invalid(cbor, "MIRTarget: Simple not allowed"),
          }),
          encode: MIRTargetBase.match({
            coin: (value) => Effect.succeed(uint(value.value)),
            map: (value) =>
              Effect.all(value.entries.map(encodeMIRMapEntry)).pipe(
                Effect.map((entries) => cborMap(entries)),
              ),
          }),
        }),
      ),
  ),
);

// ────────────────────────────────────────────────────────────────────────────
// MirInner — the inner `[pot, target]` pair of MoveInstantRewards. The outer
// `[6, ...]` wrapper is added by taggedUnionLink on DCert, so MirInner is a
// 2-slot positional array one level deeper.
// ────────────────────────────────────────────────────────────────────────────

// CDDL: `mir_pot = 0 / 1` (0 = reserves, 1 = treasury).
const MirPot = Schema.BigInt.pipe(
  Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  Schema.check(Schema.isLessThanOrEqualToBigInt(1n)),
);

const MirInner = Schema.Struct({
  pot: MirPot,
  target: MIRTarget,
}).pipe(withCborLink((walked) => positionalArrayLink(["pot", "target"])(walked)));

// ────────────────────────────────────────────────────────────────────────────
// DCert — discriminated union of all certificate types.
// Wire shape (taggedUnionLink): [tag, ...memberFields].
//
// Per Conway CDDL, pool_registration is an inline group: `(3, pool_params)`
// flattens pool_params' 9 fields into the enclosing array — the variant must
// therefore expose those 9 fields directly, NOT a nested `poolParams` struct.
// ────────────────────────────────────────────────────────────────────────────

export const DCert = Schema.Union([
  Schema.TaggedStruct(CertKind.StakeRegistration, { credential: Credential }),
  Schema.TaggedStruct(CertKind.StakeDeregistration, { credential: Credential }),
  Schema.TaggedStruct(CertKind.StakeDelegation, { credential: Credential, poolKeyHash: Bytes28 }),
  // PoolRegistration is CDDL inline-group over pool_params — flat wire layout.
  Schema.TaggedStruct(CertKind.PoolRegistration, {
    operator: Bytes28,
    vrfKeyHash: Bytes32,
    pledge: Word64BigInt,
    cost: Word64BigInt,
    margin: UnitInterval,
    rewardAccount: RewardAccount,
    owners: Schema.Array(Bytes28),
    relays: Schema.Array(Relay),
    metadata: Schema.NullOr(PoolMetadata),
  }),
  Schema.TaggedStruct(CertKind.PoolRetirement, { poolKeyHash: Bytes28, epoch: Word64BigInt }),
  Schema.TaggedStruct(CertKind.GenesisKeyDelegation, {
    genesisHash: Bytes28,
    genesisDelegateHash: Bytes28,
    vrfKeyHash: Bytes32,
  }),
  // MoveInstantRewards wire: [6, [pot, target]]. The nested 2-slot array
  // lives under `inner` so taggedUnionLink preserves the extra nesting level.
  Schema.TaggedStruct(CertKind.MoveInstantRewards, { inner: MirInner }),
  Schema.TaggedStruct(CertKind.RegDeposit, { credential: Credential, deposit: Word64BigInt }),
  Schema.TaggedStruct(CertKind.UnregDeposit, { credential: Credential, deposit: Word64BigInt }),
  Schema.TaggedStruct(CertKind.VoteDeleg, { credential: Credential, drep: DRep }),
  Schema.TaggedStruct(CertKind.StakeVoteDeleg, {
    credential: Credential,
    poolKeyHash: Bytes28,
    drep: DRep,
  }),
  Schema.TaggedStruct(CertKind.StakeRegDeleg, {
    credential: Credential,
    poolKeyHash: Bytes28,
    deposit: Word64BigInt,
  }),
  Schema.TaggedStruct(CertKind.VoteRegDeleg, {
    credential: Credential,
    drep: DRep,
    deposit: Word64BigInt,
  }),
  Schema.TaggedStruct(CertKind.StakeVoteRegDeleg, {
    credential: Credential,
    poolKeyHash: Bytes28,
    drep: DRep,
    deposit: Word64BigInt,
  }),
  Schema.TaggedStruct(CertKind.AuthCommitteeHot, {
    coldCredential: Credential,
    hotCredential: Credential,
  }),
  Schema.TaggedStruct(CertKind.ResignCommitteeCold, {
    coldCredential: Credential,
    anchor: Schema.NullOr(Anchor),
  }),
  Schema.TaggedStruct(CertKind.RegDRep, {
    credential: Credential,
    deposit: Word64BigInt,
    anchor: Schema.NullOr(Anchor),
  }),
  Schema.TaggedStruct(CertKind.UnregDRep, { credential: Credential, deposit: Word64BigInt }),
  Schema.TaggedStruct(CertKind.UpdateDRep, {
    credential: Credential,
    anchor: Schema.NullOr(Anchor),
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type DCert = typeof DCert.Type;

// ────────────────────────────────────────────────────────────────────────────
// Domain predicates
// ────────────────────────────────────────────────────────────────────────────

export const isDelegationCert = DCert.isAnyOf([
  CertKind.StakeDelegation,
  CertKind.VoteDeleg,
  CertKind.StakeVoteDeleg,
  CertKind.StakeRegDeleg,
  CertKind.VoteRegDeleg,
  CertKind.StakeVoteRegDeleg,
]);

export const isRegistrationCert = DCert.isAnyOf([
  CertKind.StakeRegistration,
  CertKind.RegDeposit,
  CertKind.StakeRegDeleg,
  CertKind.VoteRegDeleg,
  CertKind.StakeVoteRegDeleg,
]);

export const isPoolCert = DCert.isAnyOf([CertKind.PoolRegistration, CertKind.PoolRetirement]);

export const isGovernanceCert = DCert.isAnyOf([
  CertKind.AuthCommitteeHot,
  CertKind.ResignCommitteeCold,
  CertKind.RegDRep,
  CertKind.UnregDRep,
  CertKind.UpdateDRep,
]);

export const isDeregistrationCert = DCert.isAnyOf([
  CertKind.StakeDeregistration,
  CertKind.UnregDeposit,
]);

export const isDRepCert = DCert.isAnyOf([
  CertKind.RegDRep,
  CertKind.UnregDRep,
  CertKind.UpdateDRep,
]);

export const isCommitteeCert = DCert.isAnyOf([
  CertKind.AuthCommitteeHot,
  CertKind.ResignCommitteeCold,
]);

// ────────────────────────────────────────────────────────────────────────────
// Derived codecs
// ────────────────────────────────────────────────────────────────────────────

export const DCertBytes = toCodecCborBytes(DCert);
export const DCertCbor = toCodecCbor(DCert);
