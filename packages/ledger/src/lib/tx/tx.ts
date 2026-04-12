import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect";
import { CborSchemaFromBytes, CborKinds, type CborSchemaType, encodeSync } from "cbor-schema";
import {
  uint,
  cborBytes,
  negInt,
  arr,
  mapEntry,
  getCborSet,
  expectArray,
  expectUint,
  expectInt,
  expectBytes,
  expectMap,
  expectText,
  getMapValue,
} from "../core/cbor-utils.ts";
import { Bytes28, Bytes32, Bytes64 } from "../core/hashes.ts";
import { decodeValue, encodeValue, Value } from "../value/value.ts";
import { decodeAddr, encodeAddr, Addr, decodeRwdAddr, encodeRwdAddr } from "../address/address.ts";
import { decodeDCert, encodeDCert, DCert } from "../certs/certs.ts";
import { decodeTimelock, encodeTimelock, ScriptKind, type TimelockType } from "../script/script.ts";
import {
  CredentialKind,
  Credential,
  decodeCredential,
  encodeCredential,
} from "../core/credentials.ts";
import { decodePlutusData, PlutusData } from "../script/plutus-data.ts";
import { decodeAuxiliaryData, AuxiliaryData } from "./auxiliary-data.ts";
import { Timelock } from "../script/script.ts";
import {
  decodeVoter,
  encodeVoter,
  decodeGovActionId,
  encodeGovActionId,
  decodeVotingProcedure,
  encodeVotingProcedure,
  decodeVotingProcedures,
  decodeProposalProcedure,
  decodeGovAction,
  type Voter,
  type GovActionId,
  type VotingProcedure,
  VotingProceduresEntry,
  ProposalProcedure,
  decodeAnchor,
  encodeAnchor,
  GovAction,
} from "../governance/governance.ts";

// ────────────────────────────────────────────────────────────────────────────
// TxIn — [txId, index]
// ────────────────────────────────────────────────────────────────────────────

export const TxIn = Schema.Struct({
  txId: Bytes32,
  index: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
});
export type TxIn = typeof TxIn.Type;

export function decodeTxIn(cbor: CborSchemaType): Effect.Effect<TxIn, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "TxIn", 2);
    const txId = yield* expectBytes(items[0]!, "TxIn.txId", 32);
    const index = yield* expectUint(items[1]!, "TxIn.index");
    return { txId, index };
  });
}

export function encodeTxIn(txIn: TxIn): CborSchemaType {
  return arr(cborBytes(txIn.txId), uint(txIn.index));
}

// ────────────────────────────────────────────────────────────────────────────
// DatumOption — [0, dataHash] | [1, Tag(24, inlineDatum)]
// ────────────────────────────────────────────────────────────────────────────

export enum DatumOptionKind {
  DatumHash = 0,
  InlineDatum = 1,
}

export const DatumOption = Schema.Union([
  Schema.TaggedStruct(DatumOptionKind.DatumHash, { hash: Bytes32 }),
  Schema.TaggedStruct(DatumOptionKind.InlineDatum, { datum: Schema.Uint8Array }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type DatumOption = typeof DatumOption.Type;

function decodeDatumOption(cbor: CborSchemaType): Effect.Effect<DatumOption, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "DatumOption", 2);
    const tag = Number(yield* expectUint(items[0]!, "DatumOption.tag"));
    switch (tag) {
      case 0: {
        const hash = yield* expectBytes(items[1]!, "DatumOption.hash", 32);
        return { _tag: DatumOptionKind.DatumHash as const, hash };
      }
      case 1: {
        const datum = items[1]!;
        // Inline datum is wrapped in Tag(24, bytes) — CBOR-encoded CBOR
        if (
          datum._tag === CborKinds.Tag &&
          datum.tag === 24n &&
          datum.data._tag === CborKinds.Bytes
        )
          return { _tag: DatumOptionKind.InlineDatum as const, datum: datum.data.bytes };
        // Some encoders put raw bytes
        if (datum._tag === CborKinds.Bytes)
          return { _tag: DatumOptionKind.InlineDatum as const, datum: datum.bytes };
        return yield* Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(cbor), {
            message: "DatumOption: expected Tag(24, bytes) or bytes for inline datum",
          }),
        );
      }
      default:
        return yield* Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(cbor), {
            message: `DatumOption: unknown tag ${tag}`,
          }),
        );
    }
  });
}

const encodeDatumOption = DatumOption.match({
  [DatumOptionKind.DatumHash]: (d): CborSchemaType => arr(uint(0n), cborBytes(d.hash)),
  [DatumOptionKind.InlineDatum]: (d): CborSchemaType =>
    arr(uint(1n), { _tag: CborKinds.Tag, tag: 24n, data: cborBytes(d.datum) }),
});

// ────────────────────────────────────────────────────────────────────────────
// TxOut — multi-era CBOR decoder
// Shelley/Allegra/Mary: Array[addr, value]
// Alonzo:               Array[addr, value, datumHash]
// Babbage/Conway:        Map{0: addr, 1: value, 2?: datumOption, 3?: scriptRef}
// ────────────────────────────────────────────────────────────────────────────

export const TxOut = Schema.Struct({
  address: Schema.Uint8Array, // raw address bytes
  value: Value,
  datumOption: Schema.optional(DatumOption),
  scriptRef: Schema.optional(Schema.Uint8Array), // Tag(24, scriptBytes)
});
export type TxOut = typeof TxOut.Type;

// ────────────────────────────────────────────────────────────────────────────
// MultiEraTxOut — tagged union preserving which era format was decoded
// ────────────────────────────────────────────────────────────────────────────

/**
 * Shared fields present in every TxOut variant.
 */
const BaseTxOutFields = {
  address: Schema.Uint8Array,
  value: Value,
};

/**
 * Multi-era TxOut. Three structural variants matching the CBOR format:
 *
 * - `shelleyMary`: 2-element array [addr, value]
 * - `alonzo`:      3-element array [addr, value, datumHash?]
 * - `babbageConway`: CBOR map {0: addr, 1: value, 2?: datumOption, 3?: scriptRef}
 */
export const MultiEraTxOut = Schema.TaggedUnion({
  shelleyMary: BaseTxOutFields,
  alonzo: {
    ...BaseTxOutFields,
    datumOption: Schema.optional(DatumOption),
  },
  babbageConway: {
    ...BaseTxOutFields,
    datumOption: Schema.optional(DatumOption),
    scriptRef: Schema.optional(Schema.Uint8Array),
  },
});
export type MultiEraTxOut = typeof MultiEraTxOut.Type;

/** Map from ledger era number to MultiEraTxOut tag. */
const eraToTxOutTag: Record<number, MultiEraTxOut["_tag"]> = {
  [0]: "shelleyMary", // Byron (not used in practice — Byron has no UTxO in this format)
  [2]: "shelleyMary", // Shelley
  [3]: "shelleyMary", // Allegra
  [4]: "shelleyMary", // Mary
  [5]: "alonzo", // Alonzo
  [6]: "babbageConway", // Babbage
  [7]: "babbageConway", // Conway
};

/**
 * Decode a TxOut from CBOR AST and tag it with the appropriate era variant.
 * Falls back to structural detection when no era number is provided.
 */
export function decodeMultiEraTxOut(
  cbor: CborSchemaType,
  eraNum?: number,
): Effect.Effect<MultiEraTxOut, SchemaIssue.Issue> {
  // Determine tag from era number, or detect from CBOR structure
  const tag =
    eraNum !== undefined
      ? (eraToTxOutTag[eraNum] ?? "babbageConway")
      : cbor._tag === CborKinds.Map
        ? "babbageConway"
        : cbor._tag === CborKinds.Array && cbor.items.length === 3
          ? "alonzo"
          : "shelleyMary";

  return Effect.map(decodeTxOut(cbor), (txOut) =>
    tag === "shelleyMary"
      ? { _tag: "shelleyMary" as const, address: txOut.address, value: txOut.value }
      : tag === "alonzo"
        ? {
            _tag: "alonzo" as const,
            address: txOut.address,
            value: txOut.value,
            datumOption: txOut.datumOption,
          }
        : {
            _tag: "babbageConway" as const,
            address: txOut.address,
            value: txOut.value,
            datumOption: txOut.datumOption,
            scriptRef: txOut.scriptRef,
          },
  );
}

/** Type guards for grouping MultiEraTxOut variants. */
export const isShelleyMaryTxOut = MultiEraTxOut.isAnyOf(["shelleyMary"]);
export const isAlonzoTxOut = MultiEraTxOut.isAnyOf(["alonzo"]);
export const isBabbageConwayTxOut = MultiEraTxOut.isAnyOf(["babbageConway"]);
export const isPreBabbageTxOut = MultiEraTxOut.isAnyOf(["shelleyMary", "alonzo"]);

/** Convert a MultiEraTxOut to the canonical (flat) TxOut representation. */
export function multiEraTxOutToTxOut(me: MultiEraTxOut): TxOut {
  return MultiEraTxOut.match(me, {
    shelleyMary: (v) => ({
      address: v.address,
      value: v.value,
      datumOption: undefined,
      scriptRef: undefined,
    }),
    alonzo: (v) => ({
      address: v.address,
      value: v.value,
      datumOption: v.datumOption,
      scriptRef: undefined,
    }),
    babbageConway: (v) => ({
      address: v.address,
      value: v.value,
      datumOption: v.datumOption,
      scriptRef: v.scriptRef,
    }),
  });
}

export function decodeTxOut(cbor: CborSchemaType): Effect.Effect<TxOut, SchemaIssue.Issue> {
  // Shelley/Allegra/Mary: Array[addr, value] (2-element array)
  if (cbor._tag === CborKinds.Array && cbor.items.length === 2) {
    const addrCbor = cbor.items[0];
    const valueCbor = cbor.items[1];
    if (addrCbor?._tag !== CborKinds.Bytes)
      return Effect.fail(
        new SchemaIssue.InvalidValue(Option.some(cbor), {
          message: "TxOut: invalid address in array format",
        }),
      );
    if (!valueCbor)
      return Effect.fail(
        new SchemaIssue.InvalidValue(Option.some(cbor), {
          message: "TxOut: missing value in array format",
        }),
      );
    return Effect.map(decodeValue(valueCbor), (value) => ({
      address: addrCbor.bytes,
      value,
      datumOption: undefined,
      scriptRef: undefined,
    }));
  }

  // Alonzo: Array[addr, value, datumHash] (3-element array)
  // The datumHash in Alonzo array format is a raw 32-byte hash, NOT a [tag, value] DatumOption
  if (cbor._tag === CborKinds.Array && cbor.items.length === 3) {
    const addrCbor = cbor.items[0];
    const valueCbor = cbor.items[1];
    const datumHashCbor = cbor.items[2];
    if (addrCbor?._tag !== CborKinds.Bytes)
      return Effect.fail(
        new SchemaIssue.InvalidValue(Option.some(cbor), {
          message: "TxOut: invalid address in Alonzo array format",
        }),
      );
    if (!valueCbor)
      return Effect.fail(
        new SchemaIssue.InvalidValue(Option.some(cbor), {
          message: "TxOut: missing value in Alonzo array format",
        }),
      );

    // Handle datum: raw Bytes(32) hash, or [tag, value] DatumOption, or null
    const decodeDatum = (): Effect.Effect<DatumOption | undefined, SchemaIssue.Issue> => {
      if (!datumHashCbor) return Effect.succeed(undefined);
      // Raw hash bytes (Alonzo legacy format)
      if (datumHashCbor._tag === CborKinds.Bytes && datumHashCbor.bytes.length === 32)
        return Effect.succeed({
          _tag: DatumOptionKind.DatumHash as const,
          hash: datumHashCbor.bytes,
        });
      // DatumOption [tag, value] format (post-Alonzo)
      if (datumHashCbor._tag === CborKinds.Array && datumHashCbor.items.length === 2)
        return decodeDatumOption(datumHashCbor);
      // Null/absent
      return Effect.succeed(undefined);
    };

    return Effect.all({
      value: decodeValue(valueCbor),
      datumOption: decodeDatum(),
    }).pipe(
      Effect.map(({ value, datumOption }) => ({
        address: addrCbor.bytes,
        value,
        datumOption,
        scriptRef: undefined,
      })),
    );
  }

  // Babbage/Conway: Map{0: addr, 1: value, 2?: datumOption, 3?: scriptRef}
  if (cbor._tag === CborKinds.Map) {
    const get = (key: number) =>
      cbor.entries.find((e) => e.k._tag === CborKinds.UInt && Number(e.k.num) === key)?.v;

    const addrCbor = get(0);
    if (addrCbor?._tag !== CborKinds.Bytes)
      return Effect.fail(
        new SchemaIssue.InvalidValue(Option.some(cbor), {
          message: "TxOut: missing/invalid address (key 0)",
        }),
      );

    const valueCbor = get(1);
    if (!valueCbor)
      return Effect.fail(
        new SchemaIssue.InvalidValue(Option.some(cbor), {
          message: "TxOut: missing value (key 1)",
        }),
      );

    const datumCbor = get(2);
    const scriptCbor = get(3);

    return Effect.all({
      address: Effect.succeed(addrCbor.bytes),
      value: decodeValue(valueCbor),
      datumOption: datumCbor ? decodeDatumOption(datumCbor) : Effect.succeed(undefined),
      scriptRef: Effect.succeed(
        scriptCbor?._tag === CborKinds.Tag &&
          scriptCbor.tag === 24n &&
          scriptCbor.data._tag === CborKinds.Bytes
          ? scriptCbor.data.bytes
          : undefined,
      ),
    });
  }

  return Effect.fail(
    new SchemaIssue.InvalidValue(Option.some(cbor), {
      message: "TxOut: expected Array or Map CBOR",
    }),
  );
}

export function encodeTxOut(txOut: TxOut): CborSchemaType {
  return {
    _tag: CborKinds.Map,
    entries: [
      ...mapEntry(0, cborBytes(txOut.address)),
      ...mapEntry(1, encodeValue(txOut.value)),
      ...mapEntry(
        2,
        txOut.datumOption !== undefined ? encodeDatumOption(txOut.datumOption) : undefined,
      ),
      ...mapEntry(
        3,
        txOut.scriptRef !== undefined
          ? { _tag: CborKinds.Tag, tag: 24n, data: cborBytes(txOut.scriptRef) }
          : undefined,
      ),
    ],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// TxRedeemer
// CBOR: [tag, index, data, exunits]
// ────────────────────────────────────────────────────────────────────────────

export enum TxRedeemerTag {
  Spend = 0,
  Mint = 1,
  Cert = 2,
  Reward = 3,
  Voting = 4,
  Proposing = 5,
}

export const TxRedeemer = Schema.Struct({
  tag: Schema.Enum(TxRedeemerTag),
  index: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
  data: PlutusData,
  exUnits: Schema.Struct({ mem: Schema.BigInt, steps: Schema.BigInt }),
});
export type TxRedeemer = typeof TxRedeemer.Type;

// ────────────────────────────────────────────────────────────────────────────
// VKeyWitness — [vkey, signature]
// ────────────────────────────────────────────────────────────────────────────

export const VKeyWitness = Schema.Struct({
  vkey: Bytes32,
  signature: Bytes64,
});
export type VKeyWitness = typeof VKeyWitness.Type;

// ────────────────────────────────────────────────────────────────────────────
// BootstrapWitness — [vkey, signature, chainCode, attributes]
// ────────────────────────────────────────────────────────────────────────────

export const BootstrapWitness = Schema.Struct({
  vkey: Bytes32,
  signature: Bytes64,
  chainCode: Bytes32,
  attributes: Schema.Uint8Array,
});
export type BootstrapWitness = typeof BootstrapWitness.Type;

// ────────────────────────────────────────────────────────────────────────────
// TxWitnessSet — sparse CBOR map {0?..7?}
// ────────────────────────────────────────────────────────────────────────────

export const TxWitnessSet = Schema.Struct({
  vkeyWitnesses: Schema.optional(Schema.Array(VKeyWitness)),
  nativeScripts: Schema.optional(Schema.Array(Timelock)),
  bootstrapWitnesses: Schema.optional(Schema.Array(BootstrapWitness)),
  plutusV1Scripts: Schema.optional(Schema.Array(Schema.Uint8Array)), // compiled bytecode
  plutusData: Schema.optional(Schema.Array(PlutusData)),
  redeemers: Schema.optional(Schema.Array(TxRedeemer)),
  plutusV2Scripts: Schema.optional(Schema.Array(Schema.Uint8Array)), // compiled bytecode
  plutusV3Scripts: Schema.optional(Schema.Array(Schema.Uint8Array)), // compiled bytecode
});
export type TxWitnessSet = typeof TxWitnessSet.Type;

// ────────────────────────────────────────────────────────────────────────────
// TxBody — sparse CBOR map with keys 0-22
// ────────────────────────────────────────────────────────────────────────────

export const TxBody = Schema.Struct({
  inputs: Schema.Array(TxIn), // key 0 (required)
  outputs: Schema.Array(TxOut), // key 1 (required)
  fee: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))), // key 2 (required)
  ttl: Schema.optional(Schema.BigInt), // key 3
  certs: Schema.optional(Schema.Array(DCert)), // key 4
  withdrawals: Schema.optional(
    Schema.Array(
      Schema.Struct({
        // key 5
        rewardAccount: Schema.Uint8Array,
        coin: Schema.BigInt,
      }),
    ),
  ),
  update: Schema.optional(Schema.Uint8Array), // key 6 (opaque, Shelley-Babbage only)
  auxDataHash: Schema.optional(Bytes32), // key 7
  validityStart: Schema.optional(Schema.BigInt), // key 8
  mint: Schema.optional(
    Schema.Array(
      Schema.Struct({
        // key 9
        policy: Bytes28,
        assets: Schema.Array(Schema.Struct({ name: Schema.Uint8Array, quantity: Schema.BigInt })),
      }),
    ),
  ),
  scriptDataHash: Schema.optional(Bytes32), // key 11
  collateral: Schema.optional(Schema.Array(TxIn)), // key 13
  requiredSigners: Schema.optional(Schema.Array(Bytes28)), // key 14
  networkId: Schema.optional(Schema.BigInt), // key 15
  collateralReturn: Schema.optional(TxOut), // key 16
  totalCollateral: Schema.optional(Schema.BigInt), // key 17
  referenceInputs: Schema.optional(Schema.Array(TxIn)), // key 18
  votingProcedures: Schema.optional(Schema.Array(VotingProceduresEntry)), // key 19
  proposalProcedures: Schema.optional(Schema.Array(ProposalProcedure)), // key 20
  currentTreasury: Schema.optional(Schema.BigInt), // key 21
  donation: Schema.optional(Schema.BigInt), // key 22
});
export type TxBody = typeof TxBody.Type;

// ────────────────────────────────────────────────────────────────────────────
// Tx — [body, witnesses, isValid, auxData?]
// ────────────────────────────────────────────────────────────────────────────

export const Tx = Schema.Struct({
  body: TxBody,
  witnesses: TxWitnessSet,
  isValid: Schema.Boolean,
  auxiliaryData: Schema.optional(AuxiliaryData),
});
export type Tx = typeof Tx.Type;

// ────────────────────────────────────────────────────────────────────────────
// TxBody CBOR codec helpers
// ────────────────────────────────────────────────────────────────────────────

function decodeMultiAssetEntries(
  cbor: CborSchemaType,
): Effect.Effect<TxBody["mint"], SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Map) return Effect.succeed(undefined);
  return Effect.all(
    cbor.entries.map((e) =>
      Effect.gen(function* () {
        const policy = yield* expectBytes(e.k, "mint.policy");
        const assetMap = yield* expectMap(e.v, "mint.assets");
        const assets = yield* Effect.all(
          assetMap.map((a) =>
            Effect.gen(function* () {
              const name = yield* expectBytes(a.k, "mint.assetName");
              const quantity = yield* expectInt(a.v, "mint.quantity");
              return { name, quantity };
            }),
          ),
        );
        return { policy, assets };
      }),
    ),
  );
}

export function decodeTxBody(cbor: CborSchemaType): Effect.Effect<TxBody, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Map)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), { message: "TxBody: expected CBOR map" }),
    );

  const get = (key: number) =>
    cbor.entries.find((e) => e.k._tag === CborKinds.UInt && Number(e.k.num) === key)?.v;

  // Required: inputs (key 0) — bare Array (pre-Conway) or Tag(258, Array) (Conway)
  const inputsRaw = get(0);
  const inputItems = inputsRaw ? getCborSet(inputsRaw) : undefined;
  if (!inputItems)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), {
        message: "TxBody: missing inputs (key 0)",
      }),
    );

  // Required: outputs (key 1)
  const outputsCbor = get(1);
  if (!outputsCbor || outputsCbor._tag !== CborKinds.Array)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), {
        message: "TxBody: missing outputs (key 1)",
      }),
    );

  // Required: fee (key 2)
  const feeCbor = get(2);
  if (!feeCbor || feeCbor._tag !== CborKinds.UInt)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), { message: "TxBody: missing fee (key 2)" }),
    );

  // Optional fields
  const ttlCbor = get(3);
  const certsCbor = get(4);
  const wdrlCbor = get(5);
  const updateCbor = get(6);
  const auxHashCbor = get(7);
  const validityStartCbor = get(8);
  const mintCbor = get(9);
  const scriptDataHashCbor = get(11);
  const collateralCbor = get(13);
  const reqSignersCbor = get(14);
  const networkIdCbor = get(15);
  const collReturnCbor = get(16);
  const totCollCbor = get(17);
  const refInputsCbor = get(18);
  const votingCbor = get(19);
  const proposalsCbor = get(20);
  const treasuryCbor = get(21);
  const donationCbor = get(22);

  // Also use getCborSet for optional set-typed fields (certs, collateral, reqSigners, refInputs)
  const certItems = certsCbor ? getCborSet(certsCbor) : undefined;
  const collateralItems = collateralCbor ? getCborSet(collateralCbor) : undefined;
  const reqSignerItems = reqSignersCbor ? getCborSet(reqSignersCbor) : undefined;
  const refInputItems = refInputsCbor ? getCborSet(refInputsCbor) : undefined;

  return Effect.gen(function* () {
    const inputs = yield* Effect.all([...inputItems].map(decodeTxIn));
    const outputs = yield* Effect.all(outputsCbor.items.map(decodeTxOut));

    return {
      inputs,
      outputs,
      fee: feeCbor.num,
      ttl: ttlCbor?._tag === CborKinds.UInt ? ttlCbor.num : undefined,
      certs: certItems ? yield* Effect.all([...certItems].map(decodeDCert)) : undefined,
      withdrawals:
        wdrlCbor?._tag === CborKinds.Map
          ? wdrlCbor.entries.map((e) => ({
              rewardAccount: e.k._tag === CborKinds.Bytes ? e.k.bytes : new Uint8Array(0),
              coin: e.v._tag === CborKinds.UInt ? e.v.num : 0n,
            }))
          : undefined,
      update: updateCbor ? encodeSync(updateCbor) : undefined,
      auxDataHash:
        auxHashCbor?._tag === CborKinds.Bytes && auxHashCbor.bytes.length === 32
          ? auxHashCbor.bytes
          : undefined,
      validityStart: validityStartCbor?._tag === CborKinds.UInt ? validityStartCbor.num : undefined,
      mint: mintCbor ? yield* decodeMultiAssetEntries(mintCbor) : undefined,
      scriptDataHash:
        scriptDataHashCbor?._tag === CborKinds.Bytes && scriptDataHashCbor.bytes.length === 32
          ? scriptDataHashCbor.bytes
          : undefined,
      collateral: collateralItems
        ? yield* Effect.all([...collateralItems].map(decodeTxIn))
        : undefined,
      requiredSigners: reqSignerItems
        ? yield* Effect.all([...reqSignerItems].map((i) => expectBytes(i, "requiredSigner", 28)))
        : undefined,
      networkId: networkIdCbor?._tag === CborKinds.UInt ? networkIdCbor.num : undefined,
      collateralReturn: collReturnCbor ? yield* decodeTxOut(collReturnCbor) : undefined,
      totalCollateral: totCollCbor?._tag === CborKinds.UInt ? totCollCbor.num : undefined,
      referenceInputs: refInputItems
        ? yield* Effect.all([...refInputItems].map(decodeTxIn))
        : undefined,
      votingProcedures: votingCbor ? yield* decodeVotingProcedures(votingCbor) : undefined,
      proposalProcedures: proposalsCbor
        ? yield* Effect.all((getCborSet(proposalsCbor) ?? []).map(decodeProposalProcedure))
        : undefined,
      currentTreasury: treasuryCbor?._tag === CborKinds.UInt ? treasuryCbor.num : undefined,
      donation: donationCbor?._tag === CborKinds.UInt ? donationCbor.num : undefined,
    };
  });
}

// CBOR helpers imported from cbor-utils.ts

function encodeMint(mint: TxBody["mint"]): CborSchemaType | undefined {
  if (!mint || mint.length === 0) return undefined;
  return {
    _tag: CborKinds.Map,
    entries: mint.map((m): { k: CborSchemaType; v: CborSchemaType } => ({
      k: cborBytes(m.policy),
      v: {
        _tag: CborKinds.Map,
        entries: m.assets.map((a): { k: CborSchemaType; v: CborSchemaType } => ({
          k: cborBytes(a.name),
          v: a.quantity >= 0n ? uint(a.quantity) : negInt(a.quantity),
        })),
      },
    })),
  };
}

export function encodeTxBody(body: TxBody): CborSchemaType {
  return {
    _tag: CborKinds.Map,
    entries: [
      ...mapEntry(0, arr(...body.inputs.map(encodeTxIn))),
      ...mapEntry(1, arr(...body.outputs.map(encodeTxOut))),
      ...mapEntry(2, uint(body.fee)),
      ...mapEntry(3, body.ttl !== undefined ? uint(body.ttl) : undefined),
      ...mapEntry(
        4,
        body.certs && body.certs.length > 0 ? arr(...body.certs.map(encodeDCert)) : undefined,
      ),
      ...mapEntry(7, body.auxDataHash !== undefined ? cborBytes(body.auxDataHash) : undefined),
      ...mapEntry(8, body.validityStart !== undefined ? uint(body.validityStart) : undefined),
      ...mapEntry(9, encodeMint(body.mint)),
      ...mapEntry(
        11,
        body.scriptDataHash !== undefined ? cborBytes(body.scriptDataHash) : undefined,
      ),
      ...mapEntry(
        13,
        body.collateral && body.collateral.length > 0
          ? arr(...body.collateral.map(encodeTxIn))
          : undefined,
      ),
      ...mapEntry(
        14,
        body.requiredSigners && body.requiredSigners.length > 0
          ? arr(...body.requiredSigners.map(cborBytes))
          : undefined,
      ),
      ...mapEntry(15, body.networkId !== undefined ? uint(body.networkId) : undefined),
      ...mapEntry(
        16,
        body.collateralReturn !== undefined ? encodeTxOut(body.collateralReturn) : undefined,
      ),
      ...mapEntry(17, body.totalCollateral !== undefined ? uint(body.totalCollateral) : undefined),
      ...mapEntry(
        18,
        body.referenceInputs && body.referenceInputs.length > 0
          ? arr(...body.referenceInputs.map(encodeTxIn))
          : undefined,
      ),
      ...mapEntry(21, body.currentTreasury !== undefined ? uint(body.currentTreasury) : undefined),
      ...mapEntry(22, body.donation !== undefined ? uint(body.donation) : undefined),
    ],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Full CBOR codecs
// ────────────────────────────────────────────────────────────────────────────

export const TxInBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(TxIn, {
    decode: SchemaGetter.transformOrFail(decodeTxIn),
    encode: SchemaGetter.transform(encodeTxIn),
  }),
);

export const TxOutBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(TxOut, {
    decode: SchemaGetter.transformOrFail(decodeTxOut),
    encode: SchemaGetter.transform(encodeTxOut),
  }),
);

export const TxBodyBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(TxBody, {
    decode: SchemaGetter.transformOrFail(decodeTxBody),
    encode: SchemaGetter.transform(encodeTxBody),
  }),
);
