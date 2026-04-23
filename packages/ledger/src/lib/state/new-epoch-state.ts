/**
 * Mithril snapshot state file decoder.
 *
 * Decodes the full ExtLedgerState CBOR from a Mithril snapshot's "state"
 * file, using Schema-derived codecs for every positional / sparse shape.
 * Structure verified against preprod snapshot at slot 119,401,006.
 *
 * Credential tag reversal: in state CBOR `0=Script, 1=Key`; in block/CDDL
 * `0=Key, 1=Script`. Both encodings are modeled as sibling schemas
 * (`Credential` / `StateCredential` in `core/credentials.ts`) — this module
 * uses `StateCredential` exclusively.
 */
import {
  Effect,
  HashMap,
  Option,
  Schema,
  SchemaAST as AST,
  SchemaIssue,
  SchemaParser,
  SchemaTransformation,
} from "effect";
import {
  type CborLinkFactory,
  CborDecodeError,
  CborKinds,
  type CborValue,
  CborValue as CborValueSchema,
  cborTaggedLink,
  parse,
  positionalArrayLink,
  strictMaybe,
  toCodecCbor,
  toCodecCborBytes,
  withCborLink,
} from "codecs";
import { StateCredential, StateCredentialCbor } from "../core/credentials.ts";
import { arr, cborBytes, cborNull } from "../core/cbor-utils.ts";
import { Bytes28, Bytes32 } from "../core/hashes.ts";
import { Era, EraSchema } from "../core/era.ts";
import { Anchor, DRep } from "../governance/governance.ts";
import { PoolParamsStatePState, PoolParamsStatePStateCbor } from "../pool/pool-state.ts";
import { DepositPurpose, DepositPurposeCbor, DepositPurposeKind } from "./deposits.ts";
import { DRepState, DRepStateCbor } from "./drep-state.ts";
import { compareBytes, hashMapCodec, OpaqueCbor } from "./helpers.ts";

// ────────────────────────────────────────────────────────────────────────────
// Schema.Codec<CborValue, CborValue> helpers for primitive map keys/values.
// All plain BigInt keys/values (Coin, Epoch, pool count, etc.) share one
// codec. Tuple-keyed / struct-keyed HashMaps attach their own derivation.
// ────────────────────────────────────────────────────────────────────────────

const BigIntCbor = toCodecCbor(Schema.BigInt);
const Bytes28Cbor = toCodecCbor(Bytes28);
const Bytes32Cbor = toCodecCbor(Bytes32);
const DRepCbor = toCodecCbor(DRep);

// ────────────────────────────────────────────────────────────────────────────
// StateCredential canonical ordering (canonical CBOR §4.2.1 bytewise).
// StateCredential encodes as `[UInt(tag), Bytes(hash28)]`; the outer-array
// length is always 2, so ordering reduces to `(tag, hash)` lexicographic.
// ────────────────────────────────────────────────────────────────────────────

export const compareStateCredential = (a: StateCredential, b: StateCredential): number => {
  const tagDiff = a._tag - b._tag;
  if (tagDiff !== 0) return tagDiff;
  return compareBytes(a.hash, b.hash);
};

// ────────────────────────────────────────────────────────────────────────────
// DepositPurpose canonical ordering. All variants encode as
// `[UInt(tag), ...inner]`; ordering first by tag, then by the CBOR-serialized
// inner field. We precompute the inner-key bytes once via encodeEffect. For
// the hot path we fall back to structural comparison which is canonical-
// equivalent for same-shape variants.
// ────────────────────────────────────────────────────────────────────────────

const credentialDepositTags = [
  DepositPurposeKind.KeyDeposit,
  DepositPurposeKind.DRepDeposit,
] as const;
const govActionDepositTags = [
  DepositPurposeKind.GovActionDeposit,
  DepositPurposeKind.ProposalDeposit,
] as const;

export const compareDepositPurpose = (a: DepositPurpose, b: DepositPurpose): number => {
  const tagDiff = a._tag - b._tag;
  if (tagDiff !== 0) return tagDiff;
  if (
    DepositPurpose.isAnyOf(credentialDepositTags)(a) &&
    DepositPurpose.isAnyOf(credentialDepositTags)(b)
  ) {
    return compareStateCredential(a.credential, b.credential);
  }
  if (
    DepositPurpose.guards[DepositPurposeKind.PoolDeposit](a) &&
    DepositPurpose.guards[DepositPurposeKind.PoolDeposit](b)
  ) {
    return compareBytes(a.keyHash, b.keyHash);
  }
  if (
    DepositPurpose.isAnyOf(govActionDepositTags)(a) &&
    DepositPurpose.isAnyOf(govActionDepositTags)(b)
  ) {
    const txDiff = compareBytes(a.govActionId.txId, b.govActionId.txId);
    if (txDiff !== 0) return txDiff;
    return Number(a.govActionId.index - b.govActionId.index);
  }
  return 0;
};

// ────────────────────────────────────────────────────────────────────────────
// Bound — `[RelativeTime, SlotNo, EpochNo]` (Cardano hard-fork bound).
// ────────────────────────────────────────────────────────────────────────────

export const Bound = Schema.Struct({
  time: Schema.BigInt,
  slot: Schema.BigInt,
  epoch: Schema.BigInt,
}).pipe(withCborLink((walked) => positionalArrayLink(["time", "slot", "epoch"])(walked)));
export type Bound = typeof Bound.Type;

// ────────────────────────────────────────────────────────────────────────────
// ChainAccountState — `[treasury, reserves]`.
// ────────────────────────────────────────────────────────────────────────────

export const ChainAccountState = Schema.Struct({
  treasury: Schema.BigInt,
  reserves: Schema.BigInt,
}).pipe(withCborLink((walked) => positionalArrayLink(["treasury", "reserves"])(walked)));
export type ChainAccountState = typeof ChainAccountState.Type;

// ────────────────────────────────────────────────────────────────────────────
// AccountState — `[balance, deposit, StrictMaybe(poolDelegation),
//                 StrictMaybe(drepDelegation)]`.
// Poolkeyhash is a bare 28-byte hash; drepDelegation is a DRep tagged union.
// ────────────────────────────────────────────────────────────────────────────

export const AccountState = Schema.Struct({
  balance: Schema.BigInt,
  deposit: Schema.BigInt,
  poolDelegation: strictMaybe(Bytes28Cbor),
  drepDelegation: strictMaybe(DRepCbor),
}).pipe(
  withCborLink((walked) =>
    positionalArrayLink(["balance", "deposit", "poolDelegation", "drepDelegation"])(walked),
  ),
);
export type AccountState = typeof AccountState.Type;

// ────────────────────────────────────────────────────────────────────────────
// VState — `[dreps, committeeState, numDormantEpochs]`.
// `committeeState` is left opaque until the Conway committee-ratification
// rule-set lands (out of scope here).
// ────────────────────────────────────────────────────────────────────────────

export const VState = Schema.Struct({
  dreps: hashMapCodec({
    typeName: "VState.dreps",
    keyCodec: StateCredentialCbor,
    valueCodec: DRepStateCbor,
    compareKey: compareStateCredential,
  }),
  committeeState: OpaqueCbor,
  numDormantEpochs: Schema.BigInt,
}).pipe(
  withCborLink((walked) =>
    positionalArrayLink(["dreps", "committeeState", "numDormantEpochs"])(walked),
  ),
);
export type VState = typeof VState.Type;

// ────────────────────────────────────────────────────────────────────────────
// PState — `[legacySlot, stakePools, futureStakePools, retiring]`.
// Slot 0 carries a pre-Conway structure that current consumers do not need;
// preserved as `OpaqueCbor` so re-encode is byte-preserving.
// ────────────────────────────────────────────────────────────────────────────

export const PState = Schema.Struct({
  legacy: OpaqueCbor,
  stakePools: hashMapCodec({
    typeName: "PState.stakePools",
    keyCodec: Bytes28Cbor,
    valueCodec: PoolParamsStatePStateCbor,
    compareKey: compareBytes,
  }),
  futureStakePoolParams: hashMapCodec({
    typeName: "PState.futureStakePoolParams",
    keyCodec: Bytes28Cbor,
    valueCodec: PoolParamsStatePStateCbor,
    compareKey: compareBytes,
  }),
  retiring: hashMapCodec({
    typeName: "PState.retiring",
    keyCodec: Bytes28Cbor,
    valueCodec: BigIntCbor,
    compareKey: compareBytes,
  }),
}).pipe(
  withCborLink((walked) =>
    positionalArrayLink(["legacy", "stakePools", "futureStakePoolParams", "retiring"])(walked),
  ),
);
export type PState = typeof PState.Type;

// ────────────────────────────────────────────────────────────────────────────
// DState — `[accounts, pointers, genDelegs, instantaneousRewards]`.
// `pointers` is always empty in Conway state (pre-Shelley pointer addrs
// are legacy); kept opaque for byte preservation.
// ────────────────────────────────────────────────────────────────────────────

export const GenDelegEntry = Schema.Struct({
  delegateHash: Bytes28,
  vrfHash: Bytes32,
}).pipe(withCborLink((walked) => positionalArrayLink(["delegateHash", "vrfHash"])(walked)));
export type GenDelegEntry = typeof GenDelegEntry.Type;

const GenDelegEntryCbor = toCodecCbor(GenDelegEntry);

export const InstantaneousRewards = Schema.Struct({
  reserves: hashMapCodec({
    typeName: "InstantaneousRewards.reserves",
    keyCodec: StateCredentialCbor,
    valueCodec: BigIntCbor,
    compareKey: compareStateCredential,
  }),
  treasury: hashMapCodec({
    typeName: "InstantaneousRewards.treasury",
    keyCodec: StateCredentialCbor,
    valueCodec: BigIntCbor,
    compareKey: compareStateCredential,
  }),
  deltaReserves: Schema.BigInt,
  deltaTreasury: Schema.BigInt,
}).pipe(
  withCborLink((walked) =>
    positionalArrayLink(["reserves", "treasury", "deltaReserves", "deltaTreasury"])(walked),
  ),
);
export type InstantaneousRewards = typeof InstantaneousRewards.Type;

export const DState = Schema.Struct({
  accounts: hashMapCodec({
    typeName: "DState.accounts",
    keyCodec: StateCredentialCbor,
    valueCodec: toCodecCbor(AccountState),
    compareKey: compareStateCredential,
  }),
  pointers: OpaqueCbor,
  genDelegs: hashMapCodec({
    typeName: "DState.genDelegs",
    keyCodec: Bytes28Cbor,
    valueCodec: GenDelegEntryCbor,
    compareKey: compareBytes,
  }),
  instantaneousRewards: InstantaneousRewards,
}).pipe(
  withCborLink((walked) =>
    positionalArrayLink(["accounts", "pointers", "genDelegs", "instantaneousRewards"])(walked),
  ),
);
export type DState = typeof DState.Type;

// ────────────────────────────────────────────────────────────────────────────
// CertState — `[vState, pState, dState]`.
// ────────────────────────────────────────────────────────────────────────────

export const CertState = Schema.Struct({
  vState: VState,
  pState: PState,
  dState: DState,
}).pipe(withCborLink((walked) => positionalArrayLink(["vState", "pState", "dState"])(walked)));
export type CertState = typeof CertState.Type;

// ────────────────────────────────────────────────────────────────────────────
// Constitution — `[anchor, StrictMaybe(scriptHash)]`.
// (Mithril's state actually writes `scriptHash` as raw Bytes or Null, not the
// Haskell StrictMaybe; we accept both via a custom link below.)
// ────────────────────────────────────────────────────────────────────────────

const constitutionLink = new AST.Link(
  CborValueSchema.ast,
  SchemaTransformation.transformOrFail<
    { readonly anchor: Anchor; readonly scriptHash: Uint8Array | undefined },
    CborValue
  >({
    decode: CborValueSchema.match({
      [CborKinds.Array]: (cbor) =>
        Effect.gen(function* () {
          if (cbor.items.length !== 2) {
            return yield* Effect.fail(
              new SchemaIssue.InvalidValue(Option.some(cbor), {
                message: `Constitution: expected 2 items, got ${cbor.items.length}`,
              }),
            );
          }
          const anchor = yield* SchemaParser.decodeEffect(toCodecCbor(Anchor))(cbor.items[0]!);
          const tail = cbor.items[1]!;
          const scriptHash = CborValueSchema.guards[CborKinds.Bytes](tail) ? tail.bytes : undefined;
          return { anchor, scriptHash };
        }),
      [CborKinds.UInt]: (cbor) => invalid(cbor, "Constitution: expected Array"),
      [CborKinds.NegInt]: (cbor) => invalid(cbor, "Constitution: expected Array"),
      [CborKinds.Bytes]: (cbor) => invalid(cbor, "Constitution: expected Array"),
      [CborKinds.Text]: (cbor) => invalid(cbor, "Constitution: expected Array"),
      [CborKinds.Map]: (cbor) => invalid(cbor, "Constitution: expected Array"),
      [CborKinds.Tag]: (cbor) => invalid(cbor, "Constitution: expected Array"),
      [CborKinds.Simple]: (cbor) => invalid(cbor, "Constitution: expected Array"),
    }),
    encode: ({ anchor, scriptHash }) =>
      SchemaParser.encodeEffect(toCodecCbor(Anchor))(anchor).pipe(
        Effect.map((anchorCbor) =>
          arr(anchorCbor, scriptHash === undefined ? cborNull() : cborBytes(scriptHash)),
        ),
      ),
  }),
);

const invalid = <T>(value: T, message: string) =>
  Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message }));

const isConstitution = (u: unknown): u is Constitution =>
  typeof u === "object" && u !== null && "anchor" in u && "scriptHash" in u;

export type Constitution = {
  readonly anchor: Anchor;
  readonly scriptHash: Uint8Array | undefined;
};
export const Constitution: Schema.declare<Constitution> = Schema.declare<Constitution>(
  isConstitution,
).annotate({
  toCborLink: (): ReturnType<CborLinkFactory> => constitutionLink,
});

// ────────────────────────────────────────────────────────────────────────────
// ConwayGovState — `[proposals, committee, constitution, currentPP,
//                   previousPP, futurePP, drepPulsingState]`.
// Proposals / committee / pparams slots are opaque until Phase 8 models
// them structurally.
// ────────────────────────────────────────────────────────────────────────────

export const ConwayGovState = Schema.Struct({
  proposals: OpaqueCbor,
  committee: OpaqueCbor,
  constitution: Constitution,
  currentPParams: OpaqueCbor,
  previousPParams: OpaqueCbor,
  futurePParams: OpaqueCbor,
  drepPulsingState: OpaqueCbor,
}).pipe(
  withCborLink((walked) =>
    positionalArrayLink([
      "proposals",
      "committee",
      "constitution",
      "currentPParams",
      "previousPParams",
      "futurePParams",
      "drepPulsingState",
    ])(walked),
  ),
);
export type ConwayGovState = typeof ConwayGovState.Type;

// ────────────────────────────────────────────────────────────────────────────
// UTxOState — `[utxo, deposited, fees, govState, instantStake, donation]`.
// `utxo` is empty in the Mithril snapshot (UTxO-HD stores it in LMDB);
// retained as OpaqueCbor so re-encode is byte-preserving.
// ────────────────────────────────────────────────────────────────────────────

export const UTxOState = Schema.Struct({
  utxo: OpaqueCbor,
  deposited: Schema.BigInt,
  fees: Schema.BigInt,
  govState: ConwayGovState,
  instantStake: hashMapCodec({
    typeName: "UTxOState.instantStake",
    keyCodec: StateCredentialCbor,
    valueCodec: BigIntCbor,
    compareKey: compareStateCredential,
  }),
  donation: Schema.BigInt,
}).pipe(
  withCborLink((walked) =>
    positionalArrayLink(["utxo", "deposited", "fees", "govState", "instantStake", "donation"])(
      walked,
    ),
  ),
);
export type UTxOState = typeof UTxOState.Type;

// ────────────────────────────────────────────────────────────────────────────
// LedgerState — `[certState, utxoState]`.
// ────────────────────────────────────────────────────────────────────────────

export const LedgerState = Schema.Struct({
  certState: CertState,
  utxoState: UTxOState,
}).pipe(withCborLink((walked) => positionalArrayLink(["certState", "utxoState"])(walked)));
export type LedgerState = typeof LedgerState.Type;

// ────────────────────────────────────────────────────────────────────────────
// SnapShot — `[stake, delegations, poolParams]` (Conway 3-slot) or empty
// `[...]` for vacuous snapshots on older nodes. A custom link tolerates the
// 2-slot shape by returning empty HashMaps.
// ────────────────────────────────────────────────────────────────────────────

export type SnapShot = {
  readonly stake: HashMap.HashMap<StateCredential, bigint>;
  readonly delegations: HashMap.HashMap<StateCredential, Uint8Array>;
  readonly poolParams: HashMap.HashMap<Uint8Array, CborValue>;
};

const snapShotStakeCodec = toCodecCbor(
  hashMapCodec({
    typeName: "SnapShot.stake",
    keyCodec: StateCredentialCbor,
    valueCodec: BigIntCbor,
    compareKey: compareStateCredential,
  }),
);
const snapShotDelegationsCodec = toCodecCbor(
  hashMapCodec({
    typeName: "SnapShot.delegations",
    keyCodec: StateCredentialCbor,
    valueCodec: Bytes28Cbor,
    compareKey: compareStateCredential,
  }),
);
const snapShotPoolParamsCodec = toCodecCbor(
  hashMapCodec({
    typeName: "SnapShot.poolParams",
    keyCodec: Bytes28Cbor,
    valueCodec: OpaqueCbor,
    compareKey: compareBytes,
  }),
);

const snapShotLink = new AST.Link(
  CborValueSchema.ast,
  SchemaTransformation.transformOrFail<SnapShot, CborValue>({
    decode: CborValueSchema.match({
      [CborKinds.Array]: (cbor) =>
        Effect.gen(function* () {
          if (cbor.items.length === 0) {
            return {
              stake: HashMap.empty<StateCredential, bigint>(),
              delegations: HashMap.empty<StateCredential, Uint8Array>(),
              poolParams: HashMap.empty<Uint8Array, CborValue>(),
            };
          }
          if (cbor.items.length !== 3) {
            return yield* invalid(
              cbor,
              `SnapShot: expected 0 or 3 items, got ${cbor.items.length}`,
            );
          }
          return {
            stake: yield* SchemaParser.decodeEffect(snapShotStakeCodec)(cbor.items[0]!),
            delegations: yield* SchemaParser.decodeEffect(snapShotDelegationsCodec)(cbor.items[1]!),
            poolParams: yield* SchemaParser.decodeEffect(snapShotPoolParamsCodec)(cbor.items[2]!),
          };
        }),
      [CborKinds.UInt]: (cbor) => invalid(cbor, "SnapShot: expected Array"),
      [CborKinds.NegInt]: (cbor) => invalid(cbor, "SnapShot: expected Array"),
      [CborKinds.Bytes]: (cbor) => invalid(cbor, "SnapShot: expected Array"),
      [CborKinds.Text]: (cbor) => invalid(cbor, "SnapShot: expected Array"),
      [CborKinds.Map]: (cbor) => invalid(cbor, "SnapShot: expected Array"),
      [CborKinds.Tag]: (cbor) => invalid(cbor, "SnapShot: expected Array"),
      [CborKinds.Simple]: (cbor) => invalid(cbor, "SnapShot: expected Array"),
    }),
    encode: (snap) =>
      Effect.all({
        stake: SchemaParser.encodeEffect(snapShotStakeCodec)(snap.stake),
        delegations: SchemaParser.encodeEffect(snapShotDelegationsCodec)(snap.delegations),
        poolParams: SchemaParser.encodeEffect(snapShotPoolParamsCodec)(snap.poolParams),
      }).pipe(
        Effect.map(({ stake, delegations, poolParams }) => arr(stake, delegations, poolParams)),
      ),
  }),
);

const isSnapShot = (u: unknown): u is SnapShot =>
  typeof u === "object" && u !== null && "stake" in u && "delegations" in u && "poolParams" in u;

export const SnapShot: Schema.declare<SnapShot> = Schema.declare<SnapShot>(isSnapShot).annotate({
  toCborLink: (): ReturnType<CborLinkFactory> => snapShotLink,
});

// ────────────────────────────────────────────────────────────────────────────
// SnapShots — `[mark, set, go, fee]`.
// ────────────────────────────────────────────────────────────────────────────

export const SnapShots = Schema.Struct({
  mark: SnapShot,
  set: SnapShot,
  go: SnapShot,
  fee: Schema.BigInt,
}).pipe(withCborLink((walked) => positionalArrayLink(["mark", "set", "go", "fee"])(walked)));
export type SnapShots = typeof SnapShots.Type;

// ────────────────────────────────────────────────────────────────────────────
// EpochState — `[chainAccountState, ledgerState, snapShots, nonMyopic]`.
// ────────────────────────────────────────────────────────────────────────────

export const EpochState = Schema.Struct({
  chainAccountState: ChainAccountState,
  ledgerState: LedgerState,
  snapShots: SnapShots,
  nonMyopic: OpaqueCbor,
}).pipe(
  withCborLink((walked) =>
    positionalArrayLink(["chainAccountState", "ledgerState", "snapShots", "nonMyopic"])(walked),
  ),
);
export type EpochState = typeof EpochState.Type;

// ────────────────────────────────────────────────────────────────────────────
// IndividualPoolStake — `[stakeRatio (Tag 30), totalStake, vrfKeyHash]`.
// `stakeRatio` is a Rational (Tag 30) emitted alongside the absolute total
// and VRF key. Used by consensus leader-schedule computation.
// ────────────────────────────────────────────────────────────────────────────

// Rational = Tag(30, [numerator, denominator]). Composed of positional-array
// then Tag(30) wrapper — standard CBOR rational encoding (RFC 7049 §2.4.5).
const Rational = Schema.Struct({
  numerator: Schema.BigInt,
  denominator: Schema.BigInt,
}).pipe(
  withCborLink((walked) => {
    const positional = positionalArrayLink(["numerator", "denominator"])(walked);
    return cborTaggedLink(30n)(AST.replaceEncoding(walked, [positional]));
  }),
);

export const IndividualPoolStake = Schema.Struct({
  stakeRatio: Rational,
  totalStake: Schema.BigInt,
  vrfKeyHash: Bytes32,
}).pipe(
  withCborLink((walked) => positionalArrayLink(["stakeRatio", "totalStake", "vrfKeyHash"])(walked)),
);
export type IndividualPoolStake = typeof IndividualPoolStake.Type;

// ────────────────────────────────────────────────────────────────────────────
// PoolDistr — `[pools, totalActiveStake]`.
// ────────────────────────────────────────────────────────────────────────────

const IndividualPoolStakeCbor = toCodecCbor(IndividualPoolStake);

export const PoolDistr = Schema.Struct({
  pools: hashMapCodec({
    typeName: "PoolDistr.pools",
    keyCodec: Bytes28Cbor,
    valueCodec: IndividualPoolStakeCbor,
    compareKey: compareBytes,
  }),
  totalActiveStake: Schema.BigInt,
}).pipe(withCborLink((walked) => positionalArrayLink(["pools", "totalActiveStake"])(walked)));
export type PoolDistr = typeof PoolDistr.Type;

// ────────────────────────────────────────────────────────────────────────────
// BlocksMade — `HashMap<PoolKeyHash, UInt>`.
// Two slots: previous-epoch + current-epoch. Both share this codec.
// ────────────────────────────────────────────────────────────────────────────

export const BlocksMade = hashMapCodec({
  typeName: "BlocksMade",
  keyCodec: Bytes28Cbor,
  valueCodec: BigIntCbor,
  compareKey: compareBytes,
});
export type BlocksMade = HashMap.HashMap<Uint8Array, bigint>;

// ────────────────────────────────────────────────────────────────────────────
// NewEpochState — `[epoch, blocksMadePrev, blocksMadeCur, epochState,
//                  rewardUpdate, poolDistr, stashedAVVMAddresses]`.
// ────────────────────────────────────────────────────────────────────────────

export const NewEpochState = Schema.Struct({
  epoch: Schema.BigInt,
  blocksMadePrev: BlocksMade,
  blocksMadeCur: BlocksMade,
  epochState: EpochState,
  rewardUpdate: OpaqueCbor,
  poolDistr: PoolDistr,
  stashedAVVMAddresses: OpaqueCbor,
}).pipe(
  withCborLink((walked) =>
    positionalArrayLink([
      "epoch",
      "blocksMadePrev",
      "blocksMadeCur",
      "epochState",
      "rewardUpdate",
      "poolDistr",
      "stashedAVVMAddresses",
    ])(walked),
  ),
);
export type NewEpochState = typeof NewEpochState.Type;

// ────────────────────────────────────────────────────────────────────────────
// ShelleyTip — `WithOrigin([slot, blockNo, hash32])`:
//   `Array(0)` = Origin (no blocks yet)
//   `Array(1, [slot, blockNo, hash])` = At(tip)
// ────────────────────────────────────────────────────────────────────────────

export const ShelleyTip = Schema.Struct({
  slot: Schema.BigInt,
  blockNo: Schema.BigInt,
  hash: Bytes32,
});
export type ShelleyTip = typeof ShelleyTip.Type;

const tipInnerCodec = ShelleyTip.pipe(
  withCborLink((walked) => positionalArrayLink(["slot", "blockNo", "hash"])(walked)),
);

const tipLink = new AST.Link(
  CborValueSchema.ast,
  SchemaTransformation.transformOrFail<Option.Option<ShelleyTip>, CborValue>({
    decode: CborValueSchema.match({
      [CborKinds.Array]: (cbor) => {
        switch (cbor.items.length) {
          case 0:
            return Effect.succeed(Option.none());
          case 1:
            return SchemaParser.decodeEffect(toCodecCbor(tipInnerCodec))(cbor.items[0]!).pipe(
              Effect.map(Option.some),
            );
          default:
            return invalid(
              cbor,
              `ShelleyTip: expected Array(0|1), got length ${cbor.items.length}`,
            );
        }
      },
      [CborKinds.UInt]: (cbor) => invalid(cbor, "ShelleyTip: expected Array"),
      [CborKinds.NegInt]: (cbor) => invalid(cbor, "ShelleyTip: expected Array"),
      [CborKinds.Bytes]: (cbor) => invalid(cbor, "ShelleyTip: expected Array"),
      [CborKinds.Text]: (cbor) => invalid(cbor, "ShelleyTip: expected Array"),
      [CborKinds.Map]: (cbor) => invalid(cbor, "ShelleyTip: expected Array"),
      [CborKinds.Tag]: (cbor) => invalid(cbor, "ShelleyTip: expected Array"),
      [CborKinds.Simple]: (cbor) => invalid(cbor, "ShelleyTip: expected Array"),
    }),
    encode: (opt) =>
      Option.match(opt, {
        onNone: () => Effect.succeed(arr()),
        onSome: (tip) =>
          SchemaParser.encodeEffect(toCodecCbor(tipInnerCodec))(tip).pipe(
            Effect.map((inner) => arr(inner)),
          ),
      }),
  }),
);

const isTipOption = (u: unknown): u is Option.Option<ShelleyTip> => Option.isOption(u);

export const ShelleyTipOption: Schema.declare<Option.Option<ShelleyTip>> = Schema.declare<
  Option.Option<ShelleyTip>
>(isTipOption).annotate({
  toCborLink: (): ReturnType<CborLinkFactory> => tipLink,
});

// ────────────────────────────────────────────────────────────────────────────
// PastEra — `[start: Bound, end: Bound]` plus an era label.
// ────────────────────────────────────────────────────────────────────────────

export const PastEra = Schema.Struct({
  era: EraSchema,
  start: Bound,
  end: Bound,
});
export type PastEra = typeof PastEra.Type;

// ────────────────────────────────────────────────────────────────────────────
// ExtLedgerState — top-level wrapper decoded in `decodeExtLedgerState`.
// Structure: `[version, [telescope, chainDepState]]` where `telescope` is a
// heterogeneous array whose last element is the current era and preceding
// elements are `[start, end]` records for each past era.
// ────────────────────────────────────────────────────────────────────────────

export const ExtLedgerState = Schema.Struct({
  pastEras: Schema.Array(PastEra),
  currentEra: EraSchema,
  currentStart: Bound,
  tip: Schema.Option(ShelleyTip),
  newEpochState: NewEpochState,
  transition: Schema.BigInt,
  chainDepState: CborValueSchema,
});
export type ExtLedgerState = typeof ExtLedgerState.Type;

const ERA_NAMES: ReadonlyArray<Era> = [
  Era.Byron,
  Era.Shelley,
  Era.Allegra,
  Era.Mary,
  Era.Alonzo,
  Era.Babbage,
  Era.Conway,
];

const BoundCodec = toCodecCbor(Bound);
const NewEpochStateCodec = toCodecCbor(NewEpochState);
const ShelleyTipCodec = toCodecCbor(ShelleyTipOption);

const decodeBound = SchemaParser.decodeEffect(BoundCodec);

const decodePastEra = (item: CborValue, index: number): Effect.Effect<PastEra, SchemaIssue.Issue> =>
  Effect.gen(function* () {
    const era = ERA_NAMES[index];
    if (era === undefined) return yield* invalid(item, `Past[${index}]: no era for index`);
    const pastItems = yield* expectArrayLen(item, `Past[${index}]`, 2);
    return {
      era,
      start: yield* decodeBound(pastItems[0]!),
      end: yield* decodeBound(pastItems[1]!),
    };
  });

// Hand-rolled top-level decoder. The Telescope / VersionedLedgerState layers
// are too bespoke to model as a positional Struct (the telescope is
// variable-length with a heterogeneous final slot), so this outer shell
// dispatches Effect-fully and delegates every structural substep to a
// Schema-derived codec below.
export const decodeExtLedgerState = (
  stateBytes: Uint8Array,
): Effect.Effect<ExtLedgerState, CborDecodeError | SchemaIssue.Issue> =>
  parse(stateBytes).pipe(
    Effect.flatMap((cbor) =>
      Effect.gen(function* () {
        const topItems = yield* expectArrayLen(cbor, "StateFile", 2);
        // topItems[0] is a UInt version; we don't use it explicitly.
        const extItems = yield* expectArrayLen(topItems[1]!, "ExtLedgerState", 2);
        const telescopeItems = yield* expectArray(extItems[0]!, "Telescope");
        const chainDepState = extItems[1]!;

        const eraIndex = telescopeItems.length - 1;
        const currentEra = ERA_NAMES[eraIndex];
        if (currentEra === undefined) {
          return yield* invalid(extItems[0]!, `Telescope: invalid era index ${eraIndex}`);
        }

        const pastEras = yield* Effect.forEach(telescopeItems.slice(0, eraIndex), decodePastEra);

        const currentItems = yield* expectArrayLen(telescopeItems[eraIndex]!, "Current", 2);
        const currentStart = yield* decodeBound(currentItems[0]!);

        const versioned = yield* expectArrayLen(currentItems[1]!, "VersionedLedgerState", 2);
        // versioned[0] is the LS format version — not surfaced.
        const lsContent = yield* expectArray(versioned[1]!, "ShelleyLedgerState");
        if (lsContent.length < 3) {
          return yield* invalid(
            versioned[1]!,
            `ShelleyLedgerState: expected ≥3 fields, got ${lsContent.length}`,
          );
        }

        const tip = yield* SchemaParser.decodeEffect(ShelleyTipCodec)(lsContent[0]!);
        const newEpochState = yield* SchemaParser.decodeEffect(NewEpochStateCodec)(lsContent[1]!);
        const transition = yield* expectUint(lsContent[2]!, "transition");

        return {
          pastEras,
          currentEra,
          currentStart,
          tip,
          newEpochState,
          transition,
          chainDepState,
        };
      }),
    ),
  );

// ────────────────────────────────────────────────────────────────────────────
// Thin CBOR-level Effect shims used only by `decodeExtLedgerState`'s outer
// dispatch (Telescope, VersionedLedgerState, ShelleyLedgerState). Inline
// rather than re-importing `cbor-utils.ts` — those helpers will be deleted
// when every callsite has migrated to derivation.
// ────────────────────────────────────────────────────────────────────────────

const expectArray = (
  cbor: CborValue,
  ctx: string,
): Effect.Effect<ReadonlyArray<CborValue>, SchemaIssue.Issue> =>
  CborValueSchema.guards[CborKinds.Array](cbor)
    ? Effect.succeed(cbor.items)
    : invalid(cbor, `${ctx}: expected Array`);

const expectArrayLen = (
  cbor: CborValue,
  ctx: string,
  len: number,
): Effect.Effect<ReadonlyArray<CborValue>, SchemaIssue.Issue> =>
  expectArray(cbor, ctx).pipe(
    Effect.flatMap((items) =>
      items.length === len
        ? Effect.succeed(items)
        : invalid(cbor, `${ctx}: expected ${len} items, got ${items.length}`),
    ),
  );

const expectUint = (cbor: CborValue, ctx: string): Effect.Effect<bigint, SchemaIssue.Issue> =>
  CborValueSchema.guards[CborKinds.UInt](cbor)
    ? Effect.succeed(cbor.num)
    : invalid(cbor, `${ctx}: expected UInt`);

// ────────────────────────────────────────────────────────────────────────────
// Derived Codec<T, Uint8Array> exports — for consumers that want to decode
// substructures independently of the top-level `decodeExtLedgerState`.
// ────────────────────────────────────────────────────────────────────────────

export const NewEpochStateBytes = toCodecCborBytes(NewEpochState);
export const EpochStateBytes = toCodecCborBytes(EpochState);
export const LedgerStateBytes = toCodecCborBytes(LedgerState);
export const CertStateBytes = toCodecCborBytes(CertState);
export const VStateBytes = toCodecCborBytes(VState);
export const PStateBytes = toCodecCborBytes(PState);
export const DStateBytes = toCodecCborBytes(DState);
export const UTxOStateBytes = toCodecCborBytes(UTxOState);
export const ConwayGovStateBytes = toCodecCborBytes(ConwayGovState);
export const PoolDistrBytes = toCodecCborBytes(PoolDistr);

// Re-export related types that downstream consumers still reach for from
// this module.
export {
  DepositPurpose,
  DepositPurposeCbor,
  DRepState,
  DRepStateCbor,
  PoolParamsStatePState,
  PoolParamsStatePStateCbor,
  StateCredential,
  StateCredentialCbor,
};

// Re-export era / anchor types for backwards compatibility with consumers
// that used to import them from this module.
export { Anchor, DRep, Era };

// DRep / Anchor type aliases used by legacy consumer code.
export type StateDRep = DRep;
export type StateAnchor = Anchor;
