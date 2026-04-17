/**
 * Mithril snapshot state file decoder.
 *
 * Decodes the full ExtLedgerState CBOR from a Mithril snapshot's "state" file.
 * Structure verified against real preprod snapshot at slot 119,401,006.
 *
 * Key encoding quirk: Credential tags are REVERSED in state CBOR vs block CBOR.
 * State: 0=Script, 1=Key. Block/CDDL: 0=Key, 1=Script.
 */
import { Effect, Option, Schema } from "effect";
import { CborKinds, type CborSchemaType, parseSync } from "codecs";
import { Era } from "../core/era.ts";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class StateDecodeError extends Schema.TaggedErrorClass<StateDecodeError>()(
  "StateDecodeError",
  {
    context: Schema.String,
    expected: Schema.String,
    actual: Schema.String,
  },
) {
  override get message() {
    return `${this.context}: expected ${this.expected}, got ${this.actual}`;
  }
}

const fail = (context: string, expected: string, actual: string) =>
  Effect.fail(new StateDecodeError({ context, expected, actual }));

// ---------------------------------------------------------------------------
// CBOR extraction helpers
// ---------------------------------------------------------------------------

function expectArray(
  cbor: CborSchemaType,
  ctx: string,
  len?: number,
): Effect.Effect<ReadonlyArray<CborSchemaType>, StateDecodeError> {
  if (cbor._tag !== CborKinds.Array) return fail(ctx, "array", `tag ${cbor._tag}`);
  if (len !== undefined && cbor.items.length !== len)
    return fail(ctx, `${len} items`, `${cbor.items.length}`);
  return Effect.succeed(cbor.items);
}

function expectUint(cbor: CborSchemaType, ctx: string): Effect.Effect<bigint, StateDecodeError> {
  if (cbor._tag === CborKinds.UInt) return Effect.succeed(cbor.num);
  if (cbor._tag === CborKinds.Tag && cbor.tag === 2n && cbor.data._tag === CborKinds.Bytes) {
    let n = 0n;
    for (const b of cbor.data.bytes) n = (n << 8n) | BigInt(b);
    return Effect.succeed(n);
  }
  return fail(ctx, "uint", `tag ${cbor._tag}`);
}

function expectBytes(
  cbor: CborSchemaType,
  ctx: string,
): Effect.Effect<Uint8Array, StateDecodeError> {
  if (cbor._tag !== CborKinds.Bytes) return fail(ctx, "bytes", `tag ${cbor._tag}`);
  return Effect.succeed(cbor.bytes);
}

function expectMap(
  cbor: CborSchemaType,
  ctx: string,
): Effect.Effect<ReadonlyArray<{ k: CborSchemaType; v: CborSchemaType }>, StateDecodeError> {
  if (cbor._tag !== CborKinds.Map) return fail(ctx, "map", `tag ${cbor._tag}`);
  return Effect.succeed(cbor.entries);
}

function expectText(cbor: CborSchemaType, ctx: string): Effect.Effect<string, StateDecodeError> {
  if (cbor._tag !== CborKinds.Text) return fail(ctx, "text", `tag ${cbor._tag}`);
  return Effect.succeed(cbor.text);
}

function isNull(cbor: CborSchemaType): boolean {
  return cbor._tag === CborKinds.Simple && cbor.value === null;
}

// Decode a CBOR map into a Map<string, T> using key/value decoders
function decodeMap<T>(
  cbor: CborSchemaType,
  ctx: string,
  decodeKey: (c: CborSchemaType) => Effect.Effect<string, StateDecodeError>,
  decodeValue: (c: CborSchemaType) => Effect.Effect<T, StateDecodeError>,
): Effect.Effect<ReadonlyMap<string, T>, StateDecodeError> {
  return expectMap(cbor, ctx).pipe(
    Effect.flatMap((entries) =>
      Effect.all(entries.map((e) => Effect.all([decodeKey(e.k), decodeValue(e.v)]))),
    ),
    Effect.map((pairs) => new Map(pairs)),
  );
}

// Hex-encode a credential for use as map key
function credKey(cred: StateCredential): string {
  return `${cred.kind}:${cred.hash.toHex()}`;
}

function hashKey(hash: Uint8Array): string {
  return hash.toHex();
}

// Unwrap Tag(258, Array) or bare Array into items
function getSetItems(cbor: CborSchemaType): ReadonlyArray<CborSchemaType> {
  if (cbor._tag === CborKinds.Tag && cbor.tag === 258n && cbor.data._tag === CborKinds.Array)
    return cbor.data.items;
  if (cbor._tag === CborKinds.Array) return cbor.items;
  return [];
}

// ---------------------------------------------------------------------------
// Rational: Tag(30, [num, den])
// ---------------------------------------------------------------------------

export interface StateRational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

function decodeRational(
  cbor: CborSchemaType,
  ctx: string,
): Effect.Effect<StateRational, StateDecodeError> {
  if (cbor._tag !== CborKinds.Tag || cbor.tag !== 30n)
    return fail(ctx, "Tag(30)", `tag ${cbor._tag}`);
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor.data, ctx, 2);
    return {
      numerator: yield* expectUint(items[0]!, ctx),
      denominator: yield* expectUint(items[1]!, ctx),
    };
  });
}

// StrictMaybe: Array(0)=Nothing, Array(1,[x])=Just(x), null=Nothing
function decodeStrictMaybe<T>(
  cbor: CborSchemaType,
  ctx: string,
  decodeInner: (c: CborSchemaType) => Effect.Effect<T, StateDecodeError>,
): Effect.Effect<T | undefined, StateDecodeError> {
  if (isNull(cbor)) return Effect.succeed(undefined);
  if (cbor._tag === CborKinds.Array && cbor.items.length === 0) return Effect.succeed(undefined);
  if (cbor._tag === CborKinds.Array && cbor.items.length === 1) return decodeInner(cbor.items[0]!);
  return decodeInner(cbor);
}

// ---------------------------------------------------------------------------
// Credential (State CBOR: 0=Script, 1=Key — reversed from block CBOR)
// ---------------------------------------------------------------------------

export interface StateCredential {
  readonly kind: "key" | "script";
  readonly hash: Uint8Array;
}

function decodeStateCredential(
  cbor: CborSchemaType,
  ctx: string,
): Effect.Effect<StateCredential, StateDecodeError> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, ctx, 2);
    const tag = yield* expectUint(items[0]!, ctx);
    const hash = yield* expectBytes(items[1]!, ctx);
    // REVERSED mapping in state CBOR: 0=Script, 1=Key
    return { kind: tag === 0n ? "script" : "key", hash } as const;
  });
}

// ---------------------------------------------------------------------------
// Bound: [RelativeTime, SlotNo, EpochNo]
// ---------------------------------------------------------------------------

export interface Bound {
  readonly time: bigint;
  readonly slot: bigint;
  readonly epoch: bigint;
}

function decodeBound(cbor: CborSchemaType, ctx: string): Effect.Effect<Bound, StateDecodeError> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, ctx);
    return {
      time: yield* expectUint(items[0]!, `${ctx}.time`),
      slot: yield* expectUint(items[1]!, `${ctx}.slot`),
      epoch: yield* expectUint(items[2]!, `${ctx}.epoch`),
    };
  });
}

// ---------------------------------------------------------------------------
// Anchor: [url, hash32]
// ---------------------------------------------------------------------------

export interface StateAnchor {
  readonly url: string;
  readonly hash: Uint8Array;
}

function decodeAnchor(
  cbor: CborSchemaType,
  ctx: string,
): Effect.Effect<StateAnchor, StateDecodeError> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, ctx, 2);
    return {
      url: yield* expectText(items[0]!, `${ctx}.url`),
      hash: yield* expectBytes(items[1]!, `${ctx}.hash`),
    };
  });
}

// ---------------------------------------------------------------------------
// ChainAccountState: [treasury, reserves]
// ---------------------------------------------------------------------------

export interface ChainAccountState {
  readonly treasury: bigint;
  readonly reserves: bigint;
}

function decodeChainAccountState(
  cbor: CborSchemaType,
): Effect.Effect<ChainAccountState, StateDecodeError> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "ChainAccountState", 2);
    return {
      treasury: yield* expectUint(items[0]!, "treasury"),
      reserves: yield* expectUint(items[1]!, "reserves"),
    };
  });
}

// ---------------------------------------------------------------------------
// AccountState (DState entry): [balance, deposit, poolDelegation?, drepDelegation?]
// ---------------------------------------------------------------------------

export interface AccountState {
  readonly balance: bigint;
  readonly deposit: bigint;
  readonly poolDelegation: Uint8Array | undefined;
  readonly drepDelegation: StateDRep | undefined;
}

function decodeAccountState(cbor: CborSchemaType): Effect.Effect<AccountState, StateDecodeError> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "AccountState", 4);
    const balance = yield* expectUint(items[0]!, "balance");
    const deposit = yield* expectUint(items[1]!, "deposit");
    const poolDelegation = yield* decodeStrictMaybe(items[2]!, "poolDelegation", (c) =>
      expectBytes(c, "poolKeyHash"),
    );
    const drepDelegation = yield* decodeStrictMaybe(items[3]!, "drepDelegation", decodeDRep);
    return { balance, deposit, poolDelegation, drepDelegation };
  });
}

// ---------------------------------------------------------------------------
// DRep (Conway governance delegate)
// ---------------------------------------------------------------------------

export interface StateDRep {
  readonly kind: "keyHash" | "script" | "alwaysAbstain" | "alwaysNoConfidence";
  readonly hash?: Uint8Array;
}

function decodeDRep(cbor: CborSchemaType): Effect.Effect<StateDRep, StateDecodeError> {
  // DRep can be: [0, keyHash], [1, scriptHash], [2], [3], or just UInt for compact encoding
  if (cbor._tag === CborKinds.UInt) {
    switch (Number(cbor.num)) {
      case 2:
        return Effect.succeed({ kind: "alwaysAbstain" as const });
      case 3:
        return Effect.succeed({ kind: "alwaysNoConfidence" as const });
      default:
        return fail("DRep", "tag 0-3", `${cbor.num}`);
    }
  }
  if (cbor._tag === CborKinds.Array && cbor.items.length >= 1) {
    return Effect.gen(function* () {
      const tag = yield* expectUint(cbor.items[0]!, "drep.tag");
      switch (Number(tag)) {
        case 0:
          return {
            kind: "keyHash" as const,
            hash: yield* expectBytes(cbor.items[1]!, "drep.hash"),
          };
        case 1:
          return { kind: "script" as const, hash: yield* expectBytes(cbor.items[1]!, "drep.hash") };
        case 2:
          return { kind: "alwaysAbstain" as const };
        case 3:
          return { kind: "alwaysNoConfidence" as const };
        default:
          return yield* fail("DRep", "tag 0-3", `${tag}`);
      }
    });
  }
  return fail("DRep", "array or uint", `tag ${cbor._tag}`);
}

// ---------------------------------------------------------------------------
// DRepState: [expiry, anchor?, deposit, delegators]
// ---------------------------------------------------------------------------

export interface DRepState {
  readonly expiry: bigint;
  readonly anchor: StateAnchor | undefined;
  readonly deposit: bigint;
  readonly delegators: ReadonlyArray<StateCredential>;
}

function decodeDRepState(cbor: CborSchemaType): Effect.Effect<DRepState, StateDecodeError> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "DRepState", 4);
    return {
      expiry: yield* expectUint(items[0]!, "expiry"),
      anchor: yield* decodeStrictMaybe(items[1]!, "anchor", (c) => decodeAnchor(c, "anchor")),
      deposit: yield* expectUint(items[2]!, "deposit"),
      delegators: yield* Effect.all(
        getSetItems(items[3]!).map((c) => decodeStateCredential(c, "delegator")),
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// RewardAccount: raw bytes (old) or structured [network, credential] (new)
// ---------------------------------------------------------------------------

/**
 * Decode a reward account that may be raw serialized bytes OR a structured
 * CBOR array [network, credential] (newer cardano-node state encoding).
 * Reconstructs the canonical 29-byte serialized reward address either way.
 *
 * Haskell ref: AccountAddress EncCBOR in cardano-ledger-core Address.hs
 * Old format: encCBOR (putAccountAddress → 29 raw bytes)
 * New format: derived struct encoding [network, credential]
 *   where credential is [credType, hash] or raw hash bytes
 */
function decodeRewardAccount(
  cbor: CborSchemaType,
  ctx: string,
): Effect.Effect<Uint8Array, StateDecodeError> {
  // Old format: already serialized as raw bytes
  return expectBytes(cbor, ctx).pipe(
    Effect.catchTag("StateDecodeError", () =>
      // New format: [network, credential_or_hash]
      Effect.gen(function* () {
        const items = yield* expectArray(cbor, ctx, 2);
        const network = yield* expectUint(items[0]!, `${ctx}.network`);

        // Credential may be structured [credType, hash] or raw hash bytes
        // (pool reward accounts are always key-based per Cardano spec)
        const { kind, hash } = yield* decodeStateCredential(items[1]!, `${ctx}.cred`).pipe(
          Effect.catchTag("StateDecodeError", () =>
            expectBytes(items[1]!, `${ctx}.hash`).pipe(
              Effect.map((h) => ({ kind: "key" as const, hash: h })),
            ),
          ),
        );

        // Reconstruct serialized reward address:
        // Header: 0xe0 (key) or 0xf0 (script) | network
        const headerByte = (kind === "key" ? 0xe0 : 0xf0) | Number(network);
        const result = new Uint8Array(29);
        result[0] = headerByte;
        result.set(hash, 1);
        return result;
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// PoolParams (in PState): [vrf, pledge, cost, margin, rewardAcct, owners, relays, metadata, deposit]
// ---------------------------------------------------------------------------

export interface StatePoolParams {
  readonly vrfKeyHash: Uint8Array;
  readonly pledge: bigint;
  readonly cost: bigint;
  readonly margin: StateRational;
  readonly rewardAccount: Uint8Array;
  readonly owners: ReadonlyArray<Uint8Array>;
  readonly relays: CborSchemaType;
  readonly metadata: StateAnchor | undefined;
  readonly deposit: bigint;
}

function decodeStatePoolParams(
  cbor: CborSchemaType,
): Effect.Effect<StatePoolParams, StateDecodeError> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "PoolParams");
    return {
      vrfKeyHash: yield* expectBytes(items[0]!, "vrf"),
      pledge: yield* expectUint(items[1]!, "pledge"),
      cost: yield* expectUint(items[2]!, "cost"),
      margin: yield* decodeRational(items[3]!, "margin"),
      rewardAccount: yield* decodeRewardAccount(items[4]!, "rewardAcct"),
      owners: yield* Effect.all(getSetItems(items[5]!).map((c) => expectBytes(c, "owner"))),
      relays: items[6]!,
      metadata: yield* decodeStrictMaybe(items[7]!, "metadata", (c) => decodeAnchor(c, "metadata")),
      deposit: items.length >= 9 ? yield* expectUint(items[8]!, "deposit") : 0n,
    };
  });
}

// ---------------------------------------------------------------------------
// VState: [dreps, committeeState, dormantEpochs]
// ---------------------------------------------------------------------------

export interface VState {
  readonly dreps: ReadonlyMap<string, DRepState>;
  readonly committeeState: ReadonlyArray<{
    credential: StateCredential;
    authorization: CborSchemaType;
  }>;
  readonly numDormantEpochs: bigint;
}

function decodeVState(cbor: CborSchemaType): Effect.Effect<VState, StateDecodeError> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "VState", 3);
    const dreps = yield* decodeMap(
      items[0]!,
      "dreps",
      (k) => decodeStateCredential(k, "drep.key").pipe(Effect.map(credKey)),
      decodeDRepState,
    );
    const committeeEntries = yield* expectMap(items[1]!, "committeeState");
    const committeeState = yield* Effect.all(
      committeeEntries.map((e) =>
        decodeStateCredential(e.k, "committee.key").pipe(
          Effect.map((credential) => ({ credential, authorization: e.v })),
        ),
      ),
    );
    return {
      dreps,
      committeeState,
      numDormantEpochs: yield* expectUint(items[2]!, "dormantEpochs"),
    };
  });
}

// ---------------------------------------------------------------------------
// PState: [vrfKeyHashes, stakePools, futureParams, retiring]
// ---------------------------------------------------------------------------

export interface PState {
  readonly stakePools: ReadonlyMap<string, StatePoolParams>;
  readonly futureStakePoolParams: ReadonlyMap<string, StatePoolParams>;
  readonly retiring: ReadonlyMap<string, bigint>;
}

function decodePState(cbor: CborSchemaType): Effect.Effect<PState, StateDecodeError> {
  const hashKeyDecoder = (ctx: string) => (k: CborSchemaType) =>
    expectBytes(k, ctx).pipe(Effect.map(hashKey));
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "PState", 4);
    return {
      stakePools: yield* decodeMap(
        items[1]!,
        "stakePools",
        hashKeyDecoder("pool.key"),
        decodeStatePoolParams,
      ),
      futureStakePoolParams: yield* decodeMap(
        items[2]!,
        "futureParams",
        hashKeyDecoder("futurePool.key"),
        decodeStatePoolParams,
      ),
      retiring: yield* decodeMap(items[3]!, "retiring", hashKeyDecoder("retire.key"), (v) =>
        expectUint(v, "retire.epoch"),
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// DState: [accounts, futureGenDelegs, genDelegs, instantaneousRewards]
// ---------------------------------------------------------------------------

export interface DState {
  readonly accounts: ReadonlyMap<string, AccountState>;
  readonly genDelegs: ReadonlyMap<string, { delegateHash: Uint8Array; vrfHash: Uint8Array }>;
  readonly instantaneousRewards: {
    readonly reserves: ReadonlyMap<string, bigint>;
    readonly treasury: ReadonlyMap<string, bigint>;
    readonly deltaReserves: bigint;
    readonly deltaTreasury: bigint;
  };
}

function decodeDState(cbor: CborSchemaType): Effect.Effect<DState, StateDecodeError> {
  const credKeyDecoder = (ctx: string) => (k: CborSchemaType) =>
    decodeStateCredential(k, ctx).pipe(Effect.map(credKey));
  const decodeIRMap = (c: CborSchemaType) =>
    decodeMap(c, "irMap", credKeyDecoder("ir.key"), (v) => expectUint(v, "ir.val"));
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "DState", 4);
    const accounts = yield* decodeMap(
      items[0]!,
      "accounts",
      credKeyDecoder("account.key"),
      decodeAccountState,
    );
    const genDelegs = yield* decodeMap(
      items[2]!,
      "genDelegs",
      (k) => expectBytes(k, "genDeleg.key").pipe(Effect.map(hashKey)),
      (v) =>
        Effect.gen(function* () {
          const val = yield* expectArray(v, "genDeleg.val", 2);
          return {
            delegateHash: yield* expectBytes(val[0]!, "delegate"),
            vrfHash: yield* expectBytes(val[1]!, "vrf"),
          };
        }),
    );
    const irItems = yield* expectArray(items[3]!, "instantaneousRewards", 4);
    return {
      accounts,
      genDelegs,
      instantaneousRewards: {
        reserves: yield* decodeIRMap(irItems[0]!),
        treasury: yield* decodeIRMap(irItems[1]!),
        deltaReserves: yield* expectUint(irItems[2]!, "deltaReserves"),
        deltaTreasury: yield* expectUint(irItems[3]!, "deltaTreasury"),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// CertState (Conway): [vState, pState, dState]
// ---------------------------------------------------------------------------

export interface CertState {
  readonly vState: VState;
  readonly pState: PState;
  readonly dState: DState;
}

function decodeCertState(cbor: CborSchemaType): Effect.Effect<CertState, StateDecodeError> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "CertState", 3);
    return {
      vState: yield* decodeVState(items[0]!),
      pState: yield* decodePState(items[1]!),
      dState: yield* decodeDState(items[2]!),
    };
  });
}

// ---------------------------------------------------------------------------
// ConwayGovState: [proposals, committee, constitution, curPP, prevPP, futurePP, drepPulsingState]
// ---------------------------------------------------------------------------

export interface Constitution {
  readonly anchor: StateAnchor;
  readonly scriptHash: Uint8Array | undefined;
}

export interface ConwayGovState {
  readonly proposals: CborSchemaType;
  readonly committee: CborSchemaType;
  readonly constitution: Constitution;
  readonly currentPParams: CborSchemaType;
  readonly previousPParams: CborSchemaType;
  readonly futurePParams: CborSchemaType;
  readonly drepPulsingState: CborSchemaType;
}

function decodeConwayGovState(
  cbor: CborSchemaType,
): Effect.Effect<ConwayGovState, StateDecodeError> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "ConwayGovState", 7);
    const constItems = yield* expectArray(items[2]!, "Constitution", 2);
    const constitution: Constitution = {
      anchor: yield* decodeAnchor(constItems[0]!, "constitution.anchor"),
      scriptHash: constItems[1]!._tag === CborKinds.Bytes ? constItems[1]!.bytes : undefined,
    };
    return {
      proposals: items[0]!,
      committee: items[1]!,
      constitution,
      currentPParams: items[3]!,
      previousPParams: items[4]!,
      futurePParams: items[5]!,
      drepPulsingState: items[6]!,
    };
  });
}

// ---------------------------------------------------------------------------
// UTxOState: [utxo, deposited, fees, govState, instantStake, donation]
// ---------------------------------------------------------------------------

export interface UTxOState {
  readonly deposited: bigint;
  readonly fees: bigint;
  readonly govState: ConwayGovState;
  readonly instantStake: ReadonlyMap<string, bigint>;
  readonly donation: bigint;
}

function decodeUTxOState(cbor: CborSchemaType): Effect.Effect<UTxOState, StateDecodeError> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "UTxOState", 6);
    return {
      deposited: yield* expectUint(items[1]!, "deposited"),
      fees: yield* expectUint(items[2]!, "fees"),
      govState: yield* decodeConwayGovState(items[3]!),
      instantStake: yield* decodeMap(
        items[4]!,
        "instantStake",
        (k) => decodeStateCredential(k, "stake.key").pipe(Effect.map(credKey)),
        (v) => expectUint(v, "stake.val"),
      ),
      donation: yield* expectUint(items[5]!, "donation"),
    };
  });
}

// ---------------------------------------------------------------------------
// LedgerState: [certState, utxoState]
// ---------------------------------------------------------------------------

export interface LedgerState {
  readonly certState: CertState;
  readonly utxoState: UTxOState;
}

function decodeLedgerState(cbor: CborSchemaType): Effect.Effect<LedgerState, StateDecodeError> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "LedgerState", 2);
    return {
      certState: yield* decodeCertState(items[0]!),
      utxoState: yield* decodeUTxOState(items[1]!),
    };
  });
}

// ---------------------------------------------------------------------------
// SnapShot (old 3-element format): [stake, delegations, poolParams]
// ---------------------------------------------------------------------------

export interface SnapShot {
  readonly stake: ReadonlyMap<string, bigint>;
  readonly delegations: ReadonlyMap<string, Uint8Array>;
  readonly poolParams: ReadonlyMap<string, CborSchemaType>;
}

function decodeSnapShot(
  cbor: CborSchemaType,
  ctx: string,
): Effect.Effect<SnapShot, StateDecodeError> {
  const credKeyDecoder = (sub: string) => (k: CborSchemaType) =>
    decodeStateCredential(k, `${ctx}.${sub}.key`).pipe(Effect.map(credKey));
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, ctx);
    if (items.length !== 3 && items.length !== 2)
      return yield* fail(ctx, "2 or 3 elements", `${items.length}`);
    if (items.length === 3) {
      return {
        stake: yield* decodeMap(items[0]!, `${ctx}.stake`, credKeyDecoder("stake"), (v) =>
          expectUint(v, `${ctx}.stake.val`),
        ),
        delegations: yield* decodeMap(
          items[1]!,
          `${ctx}.delegations`,
          credKeyDecoder("deleg"),
          (v) => expectBytes(v, `${ctx}.deleg.val`),
        ),
        poolParams: yield* decodeMap(
          items[2]!,
          `${ctx}.pools`,
          (k) => expectBytes(k, `${ctx}.pool.key`).pipe(Effect.map(hashKey)),
          Effect.succeed,
        ),
      };
    }
    return { stake: new Map(), delegations: new Map(), poolParams: new Map() };
  });
}

// ---------------------------------------------------------------------------
// SnapShots: [mark, set, go, fee]
// ---------------------------------------------------------------------------

export interface SnapShots {
  readonly mark: SnapShot;
  readonly set: SnapShot;
  readonly go: SnapShot;
  readonly fee: bigint;
}

function decodeSnapShots(cbor: CborSchemaType): Effect.Effect<SnapShots, StateDecodeError> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "SnapShots", 4);
    return {
      mark: yield* decodeSnapShot(items[0]!, "mark"),
      set: yield* decodeSnapShot(items[1]!, "set"),
      go: yield* decodeSnapShot(items[2]!, "go"),
      fee: yield* expectUint(items[3]!, "fee"),
    };
  });
}

// ---------------------------------------------------------------------------
// EpochState: [accountState, ledgerState, snapShots, nonMyopic]
// ---------------------------------------------------------------------------

export interface EpochState {
  readonly chainAccountState: ChainAccountState;
  readonly ledgerState: LedgerState;
  readonly snapShots: SnapShots;
  readonly nonMyopic: CborSchemaType;
}

function decodeEpochState(cbor: CborSchemaType): Effect.Effect<EpochState, StateDecodeError> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "EpochState", 4);
    return {
      chainAccountState: yield* decodeChainAccountState(items[0]!),
      ledgerState: yield* decodeLedgerState(items[1]!),
      snapShots: yield* decodeSnapShots(items[2]!),
      nonMyopic: items[3]!,
    };
  });
}

// ---------------------------------------------------------------------------
// PoolDistr: [Map{keyHash → IndivPoolStake}, totalStake]
// ---------------------------------------------------------------------------

export interface IndividualPoolStake {
  readonly stakeRatio: StateRational;
  readonly totalStake: bigint;
  readonly vrfKeyHash: Uint8Array;
}

export interface PoolDistr {
  readonly pools: ReadonlyMap<string, IndividualPoolStake>;
  readonly totalActiveStake: bigint;
}

function decodePoolDistr(cbor: CborSchemaType): Effect.Effect<PoolDistr, StateDecodeError> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "PoolDistr", 2);
    const pools = yield* decodeMap(
      items[0]!,
      "pools",
      (k) => expectBytes(k, "pool.key").pipe(Effect.map(hashKey)),
      (v) =>
        Effect.gen(function* () {
          const s = yield* expectArray(v, "poolStake", 3);
          return {
            stakeRatio: yield* decodeRational(s[0]!, "stakeRatio"),
            totalStake: yield* expectUint(s[1]!, "totalStake"),
            vrfKeyHash: yield* expectBytes(s[2]!, "vrfKey"),
          };
        }),
    );
    return { pools, totalActiveStake: yield* expectUint(items[1]!, "totalActiveStake") };
  });
}

// ---------------------------------------------------------------------------
// BlocksMade: Map{keyHash → count}
// ---------------------------------------------------------------------------

export type BlocksMade = ReadonlyMap<string, bigint>;

function decodeBlocksMade(
  cbor: CborSchemaType,
  ctx: string,
): Effect.Effect<BlocksMade, StateDecodeError> {
  return decodeMap(
    cbor,
    ctx,
    (k) => expectBytes(k, `${ctx}.key`).pipe(Effect.map(hashKey)),
    (v) => expectUint(v, `${ctx}.val`),
  );
}

// ---------------------------------------------------------------------------
// NewEpochState: [epoch, bprev, bcur, epochState, rewardUpdate, poolDistr, stashedAVVM]
// ---------------------------------------------------------------------------

export interface NewEpochState {
  readonly epoch: bigint;
  readonly blocksMadePrev: BlocksMade;
  readonly blocksMadeCur: BlocksMade;
  readonly epochState: EpochState;
  readonly rewardUpdate: CborSchemaType;
  readonly poolDistr: PoolDistr;
  readonly stashedAVVMAddresses: CborSchemaType;
}

function decodeNewEpochState(cbor: CborSchemaType): Effect.Effect<NewEpochState, StateDecodeError> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "NewEpochState", 7);
    return {
      epoch: yield* expectUint(items[0]!, "epoch"),
      blocksMadePrev: yield* decodeBlocksMade(items[1]!, "blocksMadePrev"),
      blocksMadeCur: yield* decodeBlocksMade(items[2]!, "blocksMadeCur"),
      epochState: yield* decodeEpochState(items[3]!),
      rewardUpdate: items[4]!,
      poolDistr: yield* decodePoolDistr(items[5]!),
      stashedAVVMAddresses: items[6]!,
    };
  });
}

// ---------------------------------------------------------------------------
// ShelleyTip: WithOrigin([slot, blockNo, hash32])
// ---------------------------------------------------------------------------

export interface ShelleyTip {
  readonly slot: bigint;
  readonly blockNo: bigint;
  readonly hash: Uint8Array;
}

function decodeShelleyTip(
  cbor: CborSchemaType,
): Effect.Effect<Option.Option<ShelleyTip>, StateDecodeError> {
  if (cbor._tag === CborKinds.Array && cbor.items.length === 0)
    return Effect.succeed(Option.none());
  if (cbor._tag === CborKinds.Array && cbor.items.length === 1) {
    return Effect.gen(function* () {
      const inner = yield* expectArray(cbor.items[0]!, "ShelleyTip", 3);
      return Option.some<ShelleyTip>({
        slot: yield* expectUint(inner[0]!, "tip.slot"),
        blockNo: yield* expectUint(inner[1]!, "tip.blockNo"),
        hash: yield* expectBytes(inner[2]!, "tip.hash"),
      });
    });
  }
  return fail("ShelleyTip", "valid tip format", "unexpected format");
}

// ---------------------------------------------------------------------------
// Past era: [Bound, Bound]
// ---------------------------------------------------------------------------

export interface PastEra {
  readonly era: Era;
  readonly start: Bound;
  readonly end: Bound;
}

// ---------------------------------------------------------------------------
// ExtLedgerState — top-level decoder
// ---------------------------------------------------------------------------

export interface ExtLedgerState {
  readonly pastEras: ReadonlyArray<PastEra>;
  readonly currentEra: Era;
  readonly currentStart: Bound;
  readonly tip: Option.Option<ShelleyTip>;
  readonly newEpochState: NewEpochState;
  readonly transition: bigint;
  readonly chainDepState: CborSchemaType;
}

const ERA_NAMES: ReadonlyArray<Era> = [
  Era.Byron,
  Era.Shelley,
  Era.Allegra,
  Era.Mary,
  Era.Alonzo,
  Era.Babbage,
  Era.Conway,
];

export function decodeExtLedgerState(
  stateBytes: Uint8Array,
): Effect.Effect<ExtLedgerState, StateDecodeError> {
  return Effect.gen(function* () {
    const cbor = parseSync(stateBytes);

    // Top level: [version, [telescope, chainDepState]]
    const topItems = yield* expectArray(cbor, "StateFile", 2);
    const _version = yield* expectUint(topItems[0]!, "version");
    const extItems = yield* expectArray(topItems[1]!, "ExtLedgerState", 2);
    const telescopeItems = yield* expectArray(extItems[0]!, "Telescope");
    const chainDepState = extItems[1]!;

    const eraIndex = telescopeItems.length - 1;
    const currentEra = ERA_NAMES[eraIndex];
    if (currentEra === undefined) return yield* fail("Telescope", "valid era index", `${eraIndex}`);

    // Decode past eras
    const pastEras: PastEra[] = [];
    for (let i = 0; i < eraIndex; i++) {
      const pastItems = yield* expectArray(telescopeItems[i]!, `Past[${i}]`, 2);
      pastEras.push({
        era: ERA_NAMES[i]!,
        start: yield* decodeBound(pastItems[0]!, `Past[${i}].start`),
        end: yield* decodeBound(pastItems[1]!, `Past[${i}].end`),
      });
    }

    // Current era: [currentStart, [version, [tip, newEpochState, transition]]]
    const currentItems = yield* expectArray(telescopeItems[eraIndex]!, "Current", 2);
    const currentStart = yield* decodeBound(currentItems[0]!, "currentStart");

    const versionedLS = yield* expectArray(currentItems[1]!, "VersionedLedgerState", 2);
    const _lsVersion = yield* expectUint(versionedLS[0]!, "lsVersion");
    const lsContent = yield* expectArray(versionedLS[1]!, "ShelleyLedgerState");
    if (lsContent.length < 3)
      return yield* fail("ShelleyLedgerState", ">= 3 fields", `${lsContent.length}`);

    const tip = yield* decodeShelleyTip(lsContent[0]!);
    const newEpochState = yield* decodeNewEpochState(lsContent[1]!);
    const transition = yield* expectUint(lsContent[2]!, "transition");

    return { pastEras, currentEra, currentStart, tip, newEpochState, transition, chainDepState };
  });
}
