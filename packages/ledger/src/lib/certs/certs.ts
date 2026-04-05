import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";
import { CborKinds, type CborSchemaType } from "cbor-schema";
import {
  uint,
  nullVal,
  arr,
  expectArray,
  expectUint,
  expectBytes,
  isNull,
} from "../core/cbor-utils.ts";
import { Bytes28, Bytes32 } from "../core/hashes.ts";
import {
  Credential,
  CredentialKind,
  decodeCredential,
  encodeCredential,
} from "../core/credentials.ts";
import { DRep, decodeDRep, encodeDRep } from "../governance/governance.ts";
import { PoolParams, decodePoolParams, encodePoolParams } from "../pool/pool.ts";
import { Anchor, decodeAnchor, encodeAnchor } from "../governance/governance.ts";

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
// DCert — discriminated union of all certificate types
// ────────────────────────────────────────────────────────────────────────────

export const DCert = Schema.Union([
  Schema.TaggedStruct(CertKind.StakeRegistration, { credential: Credential }),
  Schema.TaggedStruct(CertKind.StakeDeregistration, { credential: Credential }),
  Schema.TaggedStruct(CertKind.StakeDelegation, { credential: Credential, poolKeyHash: Bytes28 }),
  Schema.TaggedStruct(CertKind.PoolRegistration, { poolParams: PoolParams }),
  Schema.TaggedStruct(CertKind.PoolRetirement, { poolKeyHash: Bytes28, epoch: Schema.BigInt }),
  Schema.TaggedStruct(CertKind.GenesisKeyDelegation, {
    genesisHash: Bytes28,
    genesisDelegateHash: Bytes28,
    vrfKeyHash: Bytes32,
  }),
  Schema.TaggedStruct(CertKind.MoveInstantRewards, {
    pot: Schema.BigInt, // 0 = Reserves, 1 = Treasury
    target: Schema.Union([
      Schema.TaggedStruct("coin" as const, { value: Schema.BigInt }),
      Schema.TaggedStruct("map" as const, {
        entries: Schema.Array(Schema.Struct({ credential: Credential, coin: Schema.BigInt })),
      }),
    ]).pipe(Schema.toTaggedUnion("_tag")),
  }),
  Schema.TaggedStruct(CertKind.RegDeposit, { credential: Credential, deposit: Schema.BigInt }),
  Schema.TaggedStruct(CertKind.UnregDeposit, { credential: Credential, deposit: Schema.BigInt }),
  Schema.TaggedStruct(CertKind.VoteDeleg, { credential: Credential, drep: DRep }),
  Schema.TaggedStruct(CertKind.StakeVoteDeleg, {
    credential: Credential,
    poolKeyHash: Bytes28,
    drep: DRep,
  }),
  Schema.TaggedStruct(CertKind.StakeRegDeleg, {
    credential: Credential,
    poolKeyHash: Bytes28,
    deposit: Schema.BigInt,
  }),
  Schema.TaggedStruct(CertKind.VoteRegDeleg, {
    credential: Credential,
    drep: DRep,
    deposit: Schema.BigInt,
  }),
  Schema.TaggedStruct(CertKind.StakeVoteRegDeleg, {
    credential: Credential,
    poolKeyHash: Bytes28,
    drep: DRep,
    deposit: Schema.BigInt,
  }),
  Schema.TaggedStruct(CertKind.AuthCommitteeHot, {
    coldCredential: Credential,
    hotCredential: Credential,
  }),
  Schema.TaggedStruct(CertKind.ResignCommitteeCold, {
    coldCredential: Credential,
    anchor: Schema.optional(Anchor),
  }),
  Schema.TaggedStruct(CertKind.RegDRep, {
    credential: Credential,
    deposit: Schema.BigInt,
    anchor: Schema.optional(Anchor),
  }),
  Schema.TaggedStruct(CertKind.UnregDRep, { credential: Credential, deposit: Schema.BigInt }),
  Schema.TaggedStruct(CertKind.UpdateDRep, {
    credential: Credential,
    anchor: Schema.optional(Anchor),
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type DCert = Schema.Schema.Type<typeof DCert>;

// Domain predicates
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
// CBOR decode/encode
// CBOR: [certTag, ...fields]
// ────────────────────────────────────────────────────────────────────────────

export function decodeDCert(cbor: CborSchemaType): Effect.Effect<DCert, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "DCert");
    const tagNum = Number(yield* expectUint(items[0]!, "DCert.tag"));

    // Positional extraction helpers
    const credAt = (idx: number) => decodeCredential(items[idx]!);
    const hashAt = (idx: number, len: number) =>
      expectBytes(items[idx]!, `DCert(${tagNum})[${idx}]`, len);
    const numAt = (idx: number) => expectUint(items[idx]!, `DCert(${tagNum})[${idx}]`);
    const drepAt = (idx: number) => decodeDRep(items[idx]!);
    const optAnchorAt = (idx: number) => {
      const a = items[idx];
      if (!a || isNull(a)) return Effect.succeed(undefined);
      return decodeAnchor(a);
    };

    switch (tagNum) {
      case CertKind.StakeRegistration:
        return { _tag: CertKind.StakeRegistration as const, credential: yield* credAt(1) };
      case CertKind.StakeDeregistration:
        return { _tag: CertKind.StakeDeregistration as const, credential: yield* credAt(1) };
      case CertKind.StakeDelegation:
        return {
          _tag: CertKind.StakeDelegation as const,
          credential: yield* credAt(1),
          poolKeyHash: yield* hashAt(2, 28),
        };
      case CertKind.PoolRegistration: {
        // Pool params are flattened in the cert: [3, op, vrf, pledge, cost, margin, rwd, owners, relays, meta]
        // Create a synthetic 9-element array from items[1..9]
        const poolArray: CborSchemaType = { _tag: CborKinds.Array, items: [...items.slice(1, 10)] };
        return {
          _tag: CertKind.PoolRegistration as const,
          poolParams: yield* decodePoolParams(poolArray),
        };
      }
      case CertKind.PoolRetirement:
        return {
          _tag: CertKind.PoolRetirement as const,
          poolKeyHash: yield* hashAt(1, 28),
          epoch: yield* numAt(2),
        };
      case CertKind.GenesisKeyDelegation:
        return {
          _tag: CertKind.GenesisKeyDelegation as const,
          genesisHash: yield* hashAt(1, 28),
          genesisDelegateHash: yield* hashAt(2, 28),
          vrfKeyHash: yield* hashAt(3, 32),
        };
      case CertKind.MoveInstantRewards: {
        // CBOR: [6, [pot, target]] where target = Map<Credential, Coin> | Coin
        const mirItems = yield* expectArray(items[1]!, "MIR", 2);
        const pot = yield* expectUint(mirItems[0]!, "MIR.pot");
        const targetCbor = mirItems[1]!;
        if (targetCbor._tag === CborKinds.UInt) {
          return {
            _tag: CertKind.MoveInstantRewards as const,
            pot,
            target: { _tag: "coin" as const, value: targetCbor.num },
          };
        }
        if (targetCbor._tag === CborKinds.Map) {
          const entries = yield* Effect.all(
            targetCbor.entries.map((e) =>
              Effect.gen(function* () {
                const credential = yield* decodeCredential(e.k);
                const coin = yield* expectUint(e.v, "MIR.coin");
                return { credential, coin };
              }),
            ),
          );
          return {
            _tag: CertKind.MoveInstantRewards as const,
            pot,
            target: { _tag: "map" as const, entries },
          };
        }
        return yield* Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(targetCbor), { message: "MIR: invalid target" }),
        );
      }
      case CertKind.RegDeposit:
        return {
          _tag: CertKind.RegDeposit as const,
          credential: yield* credAt(1),
          deposit: yield* numAt(2),
        };
      case CertKind.UnregDeposit:
        return {
          _tag: CertKind.UnregDeposit as const,
          credential: yield* credAt(1),
          deposit: yield* numAt(2),
        };
      case CertKind.VoteDeleg:
        return {
          _tag: CertKind.VoteDeleg as const,
          credential: yield* credAt(1),
          drep: yield* drepAt(2),
        };
      case CertKind.StakeVoteDeleg:
        return {
          _tag: CertKind.StakeVoteDeleg as const,
          credential: yield* credAt(1),
          poolKeyHash: yield* hashAt(2, 28),
          drep: yield* drepAt(3),
        };
      case CertKind.StakeRegDeleg:
        return {
          _tag: CertKind.StakeRegDeleg as const,
          credential: yield* credAt(1),
          poolKeyHash: yield* hashAt(2, 28),
          deposit: yield* numAt(3),
        };
      case CertKind.VoteRegDeleg:
        return {
          _tag: CertKind.VoteRegDeleg as const,
          credential: yield* credAt(1),
          drep: yield* drepAt(2),
          deposit: yield* numAt(3),
        };
      case CertKind.StakeVoteRegDeleg:
        return {
          _tag: CertKind.StakeVoteRegDeleg as const,
          credential: yield* credAt(1),
          poolKeyHash: yield* hashAt(2, 28),
          drep: yield* drepAt(3),
          deposit: yield* numAt(4),
        };
      case CertKind.AuthCommitteeHot:
        return {
          _tag: CertKind.AuthCommitteeHot as const,
          coldCredential: yield* credAt(1),
          hotCredential: yield* credAt(2),
        };
      case CertKind.ResignCommitteeCold:
        return {
          _tag: CertKind.ResignCommitteeCold as const,
          coldCredential: yield* credAt(1),
          anchor: yield* optAnchorAt(2),
        };
      case CertKind.RegDRep:
        return {
          _tag: CertKind.RegDRep as const,
          credential: yield* credAt(1),
          deposit: yield* numAt(2),
          anchor: yield* optAnchorAt(3),
        };
      case CertKind.UnregDRep:
        return {
          _tag: CertKind.UnregDRep as const,
          credential: yield* credAt(1),
          deposit: yield* numAt(2),
        };
      case CertKind.UpdateDRep:
        return {
          _tag: CertKind.UpdateDRep as const,
          credential: yield* credAt(1),
          anchor: yield* optAnchorAt(2),
        };
      default:
        return yield* Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(cbor), {
            message: `DCert: unknown tag ${tagNum}`,
          }),
        );
    }
  });
}

// CBOR helpers imported from cbor-utils.ts

export const encodeDCert = DCert.match({
  [CertKind.StakeRegistration]: (c): CborSchemaType => arr(uint(0), encodeCredential(c.credential)),
  [CertKind.StakeDeregistration]: (c): CborSchemaType =>
    arr(uint(1), encodeCredential(c.credential)),
  [CertKind.StakeDelegation]: (c): CborSchemaType =>
    arr(uint(2), encodeCredential(c.credential), { _tag: CborKinds.Bytes, bytes: c.poolKeyHash }),
  [CertKind.PoolRegistration]: (c): CborSchemaType => arr(uint(3), encodePoolParams(c.poolParams)),
  [CertKind.PoolRetirement]: (c): CborSchemaType =>
    arr(uint(4), { _tag: CborKinds.Bytes, bytes: c.poolKeyHash }, uint(c.epoch)),
  [CertKind.GenesisKeyDelegation]: (c): CborSchemaType =>
    arr(
      uint(5),
      { _tag: CborKinds.Bytes, bytes: c.genesisHash },
      { _tag: CborKinds.Bytes, bytes: c.genesisDelegateHash },
      { _tag: CborKinds.Bytes, bytes: c.vrfKeyHash },
    ),
  [CertKind.MoveInstantRewards]: (c): CborSchemaType => {
    const targetCbor: CborSchemaType =
      c.target._tag === "coin"
        ? uint(c.target.value)
        : {
            _tag: CborKinds.Map,
            entries: c.target.entries.map((e) => ({
              k: encodeCredential(e.credential),
              v: uint(e.coin),
            })),
          };
    return arr(uint(6), arr(uint(c.pot), targetCbor));
  },
  [CertKind.RegDeposit]: (c): CborSchemaType =>
    arr(uint(7), encodeCredential(c.credential), uint(c.deposit)),
  [CertKind.UnregDeposit]: (c): CborSchemaType =>
    arr(uint(8), encodeCredential(c.credential), uint(c.deposit)),
  [CertKind.VoteDeleg]: (c): CborSchemaType =>
    arr(uint(9), encodeCredential(c.credential), encodeDRep(c.drep)),
  [CertKind.StakeVoteDeleg]: (c): CborSchemaType =>
    arr(
      uint(10),
      encodeCredential(c.credential),
      { _tag: CborKinds.Bytes, bytes: c.poolKeyHash },
      encodeDRep(c.drep),
    ),
  [CertKind.StakeRegDeleg]: (c): CborSchemaType =>
    arr(
      uint(11),
      encodeCredential(c.credential),
      { _tag: CborKinds.Bytes, bytes: c.poolKeyHash },
      uint(c.deposit),
    ),
  [CertKind.VoteRegDeleg]: (c): CborSchemaType =>
    arr(uint(12), encodeCredential(c.credential), encodeDRep(c.drep), uint(c.deposit)),
  [CertKind.StakeVoteRegDeleg]: (c): CborSchemaType =>
    arr(
      uint(13),
      encodeCredential(c.credential),
      { _tag: CborKinds.Bytes, bytes: c.poolKeyHash },
      encodeDRep(c.drep),
      uint(c.deposit),
    ),
  [CertKind.AuthCommitteeHot]: (c): CborSchemaType =>
    arr(uint(14), encodeCredential(c.coldCredential), encodeCredential(c.hotCredential)),
  [CertKind.ResignCommitteeCold]: (c): CborSchemaType =>
    arr(
      uint(15),
      encodeCredential(c.coldCredential),
      c.anchor !== undefined ? encodeAnchor(c.anchor) : nullVal,
    ),
  [CertKind.RegDRep]: (c): CborSchemaType =>
    arr(
      uint(16),
      encodeCredential(c.credential),
      uint(c.deposit),
      c.anchor !== undefined ? encodeAnchor(c.anchor) : nullVal,
    ),
  [CertKind.UnregDRep]: (c): CborSchemaType =>
    arr(uint(17), encodeCredential(c.credential), uint(c.deposit)),
  [CertKind.UpdateDRep]: (c): CborSchemaType =>
    arr(
      uint(18),
      encodeCredential(c.credential),
      c.anchor !== undefined ? encodeAnchor(c.anchor) : nullVal,
    ),
});
