import { Effect, Option, Schema, SchemaIssue } from "effect";
import {
  cborCodec,
  CborKinds,
  type CborSchemaType,
  CborValue as CborValueSchema,
  encode as encodeCborBytes,
  positionalArrayLink,
  schemaErrorToIssue,
  toCodecCbor,
  toCodecCborBytes,
  withCborLink,
} from "codecs";
import {
  uint,
  cborBytes,
  cborMap,
  cborTagged,
  negInt,
  arr,
  mapEntry,
  getCborSet,
  expectArray,
  expectBytes,
  expectInt,
  expectMap,
  expectUint,
} from "../core/cbor-utils.ts";
import { Bytes28, Bytes32, Bytes64 } from "../core/hashes.ts";
import { decodeValue, encodeValue, Value } from "../value/value.ts";
import { DCertCbor, DCert } from "../certs/certs.ts";
import { PlutusData } from "../script/plutus-data.ts";
import { AuxiliaryData } from "./auxiliary-data.ts";
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
}).pipe(withCborLink((walked) => positionalArrayLink(["txId", "index"])(walked)));
export type TxIn = typeof TxIn.Type;

const TxInCbor = toCodecCbor(TxIn);

export const decodeTxIn = (cbor: CborSchemaType): Effect.Effect<TxIn, SchemaIssue.Issue> =>
  Schema.decodeEffect(TxInCbor)(cbor).pipe(schemaErrorToIssue);

export const encodeTxIn = (txIn: TxIn): Effect.Effect<CborSchemaType, SchemaIssue.Issue> =>
  Schema.encodeEffect(TxInCbor)(txIn).pipe(schemaErrorToIssue);

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
        return DatumOption.make({ _tag: DatumOptionKind.DatumHash, hash });
      }
      case 1: {
        const datum = items[1]!;
        // Inline datum is wrapped in Tag(24, bytes) — CBOR-encoded CBOR
        if (
          CborValueSchema.guards[CborKinds.Tag](datum) &&
          datum.tag === 24n &&
          CborValueSchema.guards[CborKinds.Bytes](datum.data)
        )
          return DatumOption.make({
            _tag: DatumOptionKind.InlineDatum,
            datum: datum.data.bytes,
          });
        // Some encoders put raw bytes
        if (CborValueSchema.guards[CborKinds.Bytes](datum))
          return DatumOption.make({ _tag: DatumOptionKind.InlineDatum, datum: datum.bytes });
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
    arr(uint(1n), cborTagged(24n, cborBytes(d.datum))),
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
      : CborValueSchema.guards[CborKinds.Map](cbor)
        ? "babbageConway"
        : CborValueSchema.guards[CborKinds.Array](cbor) && cbor.items.length === 3
          ? "alonzo"
          : "shelleyMary";

  return Effect.map(decodeTxOut(cbor), (txOut) => MultiEraTxOut.make({ _tag: tag, ...txOut }));
}

/** Type guards for grouping MultiEraTxOut variants. */
export const isShelleyMaryTxOut = MultiEraTxOut.isAnyOf(["shelleyMary"]);
export const isAlonzoTxOut = MultiEraTxOut.isAnyOf(["alonzo"]);
export const isBabbageConwayTxOut = MultiEraTxOut.isAnyOf(["babbageConway"]);
export const isPreBabbageTxOut = MultiEraTxOut.isAnyOf(["shelleyMary", "alonzo"]);

/** Convert a MultiEraTxOut to the canonical (flat) TxOut representation. */
export function multiEraTxOutToTxOut({ _tag: _, ...fields }: MultiEraTxOut): TxOut {
  return TxOut.make({ datumOption: undefined, scriptRef: undefined, ...fields });
}

export function decodeTxOut(cbor: CborSchemaType): Effect.Effect<TxOut, SchemaIssue.Issue> {
  // Shelley/Allegra/Mary: Array[addr, value] (2-element array)
  if (CborValueSchema.guards[CborKinds.Array](cbor) && cbor.items.length === 2) {
    const addrCbor = cbor.items[0];
    const valueCbor = cbor.items[1];
    if (!addrCbor || !CborValueSchema.guards[CborKinds.Bytes](addrCbor))
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
    return Effect.map(decodeValue(valueCbor), (value) =>
      TxOut.make({
        address: addrCbor.bytes,
        value,
        datumOption: undefined,
        scriptRef: undefined,
      }),
    );
  }

  // Alonzo: Array[addr, value, datumHash] (3-element array)
  // The datumHash in Alonzo array format is a raw 32-byte hash, NOT a [tag, value] DatumOption
  if (CborValueSchema.guards[CborKinds.Array](cbor) && cbor.items.length === 3) {
    const addrCbor = cbor.items[0];
    const valueCbor = cbor.items[1];
    const datumHashCbor = cbor.items[2];
    if (!addrCbor || !CborValueSchema.guards[CborKinds.Bytes](addrCbor))
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
      if (
        CborValueSchema.guards[CborKinds.Bytes](datumHashCbor) &&
        datumHashCbor.bytes.length === 32
      )
        return Effect.succeed(
          DatumOption.make({ _tag: DatumOptionKind.DatumHash, hash: datumHashCbor.bytes }),
        );
      // DatumOption [tag, value] format (post-Alonzo)
      if (
        CborValueSchema.guards[CborKinds.Array](datumHashCbor) &&
        datumHashCbor.items.length === 2
      )
        return decodeDatumOption(datumHashCbor);
      // Null/absent
      return Effect.succeed(undefined);
    };

    return Effect.all({
      value: decodeValue(valueCbor),
      datumOption: decodeDatum(),
    }).pipe(
      Effect.map(({ value, datumOption }) =>
        TxOut.make({
          address: addrCbor.bytes,
          value,
          datumOption,
          scriptRef: undefined,
        }),
      ),
    );
  }

  // Babbage/Conway: Map{0: addr, 1: value, 2?: datumOption, 3?: scriptRef}
  if (CborValueSchema.guards[CborKinds.Map](cbor)) {
    const get = (key: number) =>
      cbor.entries.find(
        (e) => CborValueSchema.guards[CborKinds.UInt](e.k) && Number(e.k.num) === key,
      )?.v;

    const addrCbor = get(0);
    if (!addrCbor || !CborValueSchema.guards[CborKinds.Bytes](addrCbor))
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
        scriptCbor &&
          CborValueSchema.guards[CborKinds.Tag](scriptCbor) &&
          scriptCbor.tag === 24n &&
          CborValueSchema.guards[CborKinds.Bytes](scriptCbor.data)
          ? scriptCbor.data.bytes
          : undefined,
      ),
    }).pipe(Effect.map((fields) => TxOut.make(fields)));
  }

  return Effect.fail(
    new SchemaIssue.InvalidValue(Option.some(cbor), {
      message: "TxOut: expected Array or Map CBOR",
    }),
  );
}

export function encodeTxOut(txOut: TxOut): Effect.Effect<CborSchemaType, SchemaIssue.Issue> {
  return encodeValue(txOut.value).pipe(
    Effect.map((valueCbor) =>
      cborMap([
        ...mapEntry(0, cborBytes(txOut.address)),
        ...mapEntry(1, valueCbor),
        ...mapEntry(
          2,
          txOut.datumOption !== undefined ? encodeDatumOption(txOut.datumOption) : undefined,
        ),
        ...mapEntry(
          3,
          txOut.scriptRef !== undefined ? cborTagged(24n, cborBytes(txOut.scriptRef)) : undefined,
        ),
      ]),
    ),
  );
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

const decodeMintAsset = (a: { k: CborSchemaType; v: CborSchemaType }) =>
  Effect.all({
    name: expectBytes(a.k, "mint.assetName"),
    quantity: expectInt(a.v, "mint.quantity"),
  });

const decodeMintPolicy = (e: { k: CborSchemaType; v: CborSchemaType }) =>
  Effect.all({
    policy: expectBytes(e.k, "mint.policy"),
    assets: expectMap(e.v, "mint.assets").pipe(
      Effect.flatMap((assetMap) => Effect.all(assetMap.map(decodeMintAsset))),
    ),
  });

function decodeMultiAssetEntries(
  cbor: CborSchemaType,
): Effect.Effect<TxBody["mint"], SchemaIssue.Issue> {
  return CborValueSchema.guards[CborKinds.Map](cbor)
    ? Effect.all(cbor.entries.map(decodeMintPolicy))
    : Effect.succeed(undefined);
}

export function decodeTxBody(cbor: CborSchemaType): Effect.Effect<TxBody, SchemaIssue.Issue> {
  if (!CborValueSchema.guards[CborKinds.Map](cbor))
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), { message: "TxBody: expected CBOR map" }),
    );

  const get = (key: number) =>
    cbor.entries.find((e) => CborValueSchema.guards[CborKinds.UInt](e.k) && Number(e.k.num) === key)
      ?.v;

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
  if (!outputsCbor || !CborValueSchema.guards[CborKinds.Array](outputsCbor))
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), {
        message: "TxBody: missing outputs (key 1)",
      }),
    );

  // Required: fee (key 2)
  const feeCbor = get(2);
  if (!feeCbor || !CborValueSchema.guards[CborKinds.UInt](feeCbor))
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

    return TxBody.make({
      inputs,
      outputs,
      fee: feeCbor.num,
      ttl: ttlCbor && CborValueSchema.guards[CborKinds.UInt](ttlCbor) ? ttlCbor.num : undefined,
      certs: certItems
        ? yield* Effect.all(
            [...certItems].map((c) => Schema.decodeEffect(DCertCbor)(c).pipe(schemaErrorToIssue)),
          )
        : undefined,
      withdrawals:
        wdrlCbor && CborValueSchema.guards[CborKinds.Map](wdrlCbor)
          ? wdrlCbor.entries.map((e) => ({
              rewardAccount: CborValueSchema.guards[CborKinds.Bytes](e.k)
                ? e.k.bytes
                : new Uint8Array(0),
              coin: CborValueSchema.guards[CborKinds.UInt](e.v) ? e.v.num : 0n,
            }))
          : undefined,
      update: updateCbor
        ? yield* encodeCborBytes(updateCbor).pipe(
            Effect.mapError(
              (e) =>
                new SchemaIssue.InvalidValue(Option.some(updateCbor), {
                  message: `TxBody.update re-encode: ${e.cause}`,
                }),
            ),
          )
        : undefined,
      auxDataHash:
        auxHashCbor &&
        CborValueSchema.guards[CborKinds.Bytes](auxHashCbor) &&
        auxHashCbor.bytes.length === 32
          ? auxHashCbor.bytes
          : undefined,
      validityStart:
        validityStartCbor && CborValueSchema.guards[CborKinds.UInt](validityStartCbor)
          ? validityStartCbor.num
          : undefined,
      mint: mintCbor ? yield* decodeMultiAssetEntries(mintCbor) : undefined,
      scriptDataHash:
        scriptDataHashCbor &&
        CborValueSchema.guards[CborKinds.Bytes](scriptDataHashCbor) &&
        scriptDataHashCbor.bytes.length === 32
          ? scriptDataHashCbor.bytes
          : undefined,
      collateral: collateralItems
        ? yield* Effect.all([...collateralItems].map(decodeTxIn))
        : undefined,
      requiredSigners: reqSignerItems
        ? yield* Effect.all([...reqSignerItems].map((i) => expectBytes(i, "requiredSigner", 28)))
        : undefined,
      networkId:
        networkIdCbor && CborValueSchema.guards[CborKinds.UInt](networkIdCbor)
          ? networkIdCbor.num
          : undefined,
      collateralReturn: collReturnCbor ? yield* decodeTxOut(collReturnCbor) : undefined,
      totalCollateral:
        totCollCbor && CborValueSchema.guards[CborKinds.UInt](totCollCbor)
          ? totCollCbor.num
          : undefined,
      referenceInputs: refInputItems
        ? yield* Effect.all([...refInputItems].map(decodeTxIn))
        : undefined,
      votingProcedures: votingCbor ? yield* decodeVotingProcedures(votingCbor) : undefined,
      proposalProcedures: proposalsCbor
        ? yield* Effect.all((getCborSet(proposalsCbor) ?? []).map(decodeProposalProcedure))
        : undefined,
      currentTreasury:
        treasuryCbor && CborValueSchema.guards[CborKinds.UInt](treasuryCbor)
          ? treasuryCbor.num
          : undefined,
      donation:
        donationCbor && CborValueSchema.guards[CborKinds.UInt](donationCbor)
          ? donationCbor.num
          : undefined,
    });
  });
}

// CBOR helpers imported from cbor-utils.ts

function encodeMint(mint: TxBody["mint"]): CborSchemaType | undefined {
  if (!mint || mint.length === 0) return undefined;
  return cborMap(
    mint.map((m) => ({
      k: cborBytes(m.policy),
      v: cborMap(
        m.assets.map((a) => ({
          k: cborBytes(a.name),
          v: a.quantity >= 0n ? uint(a.quantity) : negInt(a.quantity),
        })),
      ),
    })),
  );
}

export function encodeTxBody(body: TxBody): Effect.Effect<CborSchemaType, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const inputs = yield* Effect.all(body.inputs.map(encodeTxIn));
    const outputs = yield* Effect.all(body.outputs.map(encodeTxOut));
    const certs =
      body.certs && body.certs.length > 0
        ? yield* Effect.all(
            body.certs.map((c) => Schema.encodeEffect(DCertCbor)(c).pipe(schemaErrorToIssue)),
          )
        : undefined;
    const collateral =
      body.collateral && body.collateral.length > 0
        ? yield* Effect.all(body.collateral.map(encodeTxIn))
        : undefined;
    const collateralReturn =
      body.collateralReturn !== undefined ? yield* encodeTxOut(body.collateralReturn) : undefined;
    const referenceInputs =
      body.referenceInputs && body.referenceInputs.length > 0
        ? yield* Effect.all(body.referenceInputs.map(encodeTxIn))
        : undefined;

    return cborMap([
      ...mapEntry(0, arr(...inputs)),
      ...mapEntry(1, arr(...outputs)),
      ...mapEntry(2, uint(body.fee)),
      ...mapEntry(3, body.ttl !== undefined ? uint(body.ttl) : undefined),
      ...mapEntry(4, certs ? arr(...certs) : undefined),
      ...mapEntry(7, body.auxDataHash !== undefined ? cborBytes(body.auxDataHash) : undefined),
      ...mapEntry(8, body.validityStart !== undefined ? uint(body.validityStart) : undefined),
      ...mapEntry(9, encodeMint(body.mint)),
      ...mapEntry(
        11,
        body.scriptDataHash !== undefined ? cborBytes(body.scriptDataHash) : undefined,
      ),
      ...mapEntry(13, collateral ? arr(...collateral) : undefined),
      ...mapEntry(
        14,
        body.requiredSigners && body.requiredSigners.length > 0
          ? arr(...body.requiredSigners.map(cborBytes))
          : undefined,
      ),
      ...mapEntry(15, body.networkId !== undefined ? uint(body.networkId) : undefined),
      ...mapEntry(16, collateralReturn),
      ...mapEntry(
        17,
        body.totalCollateral !== undefined ? uint(body.totalCollateral) : undefined,
      ),
      ...mapEntry(18, referenceInputs ? arr(...referenceInputs) : undefined),
      ...mapEntry(
        21,
        body.currentTreasury !== undefined ? uint(body.currentTreasury) : undefined,
      ),
      ...mapEntry(22, body.donation !== undefined ? uint(body.donation) : undefined),
    ]);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Full CBOR codecs
// ────────────────────────────────────────────────────────────────────────────

export const TxInBytes = toCodecCborBytes(TxIn);

export const TxOutBytes = cborCodec(TxOut, decodeTxOut, encodeTxOut);

export const TxBodyBytes = cborCodec(TxBody, decodeTxBody, encodeTxBody);
