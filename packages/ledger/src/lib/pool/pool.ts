import { Effect, Option, Schema, SchemaIssue } from "effect";
import { CborKinds, type CborSchemaType } from "codecs";
import {
  uint,
  arr,
  cborBytes,
  cborText,
  nullVal,
  expectArray,
  expectUint,
  expectBytes,
  expectText,
  isNull,
  getCborSet,
} from "../core/cbor-utils.ts";
import { Bytes28, Bytes32, isByteMaxLength } from "../core/hashes.ts";
import { Rational } from "../core/primitives.ts";
import { decodeRwdAddr, encodeRwdAddr, type RwdAddr } from "../address/address.ts";

// ────────────────────────────────────────────────────────────────────────────
// Relay — how to reach a stake pool
// CBOR: [0, port?, ipv4?, ipv6?] | [1, port, dnsName] | [2, dnsName]
// ────────────────────────────────────────────────────────────────────────────

export enum RelayKind {
  SingleHostAddr = 0,
  SingleHostName = 1,
  MultiHostName = 2,
}

export const Relay = Schema.Union([
  Schema.TaggedStruct(RelayKind.SingleHostAddr, {
    port: Schema.optional(Schema.Number),
    ipv4: Schema.optional(Schema.Uint8Array),
    ipv6: Schema.optional(Schema.Uint8Array),
  }),
  Schema.TaggedStruct(RelayKind.SingleHostName, {
    port: Schema.optional(Schema.Number),
    dnsName: Schema.String,
  }),
  Schema.TaggedStruct(RelayKind.MultiHostName, {
    dnsName: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type Relay = typeof Relay.Type;

// ────────────────────────────────────────────────────────────────────────────
// Pool Metadata
// CBOR: [url, metadataHash]
// ────────────────────────────────────────────────────────────────────────────

export const PoolMetadata = Schema.Struct({
  url: Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
  hash: Bytes32,
});
export type PoolMetadata = typeof PoolMetadata.Type;

// ────────────────────────────────────────────────────────────────────────────
// PoolParams — stake pool registration parameters
// CBOR: [operator, vrfKeyhash, pledge, cost, margin, rewardAccount,
//        poolOwners, relays, poolMetadata]
// ────────────────────────────────────────────────────────────────────────────

export const PoolParams = Schema.Struct({
  operator: Bytes28,
  vrfKeyHash: Bytes32,
  pledge: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
  cost: Schema.BigInt.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))),
  margin: Rational,
  rewardAccount: Schema.Uint8Array, // raw reward address bytes
  owners: Schema.Array(Bytes28),
  relays: Schema.Array(Relay),
  metadata: Schema.optional(PoolMetadata),
});
export type PoolParams = typeof PoolParams.Type;

// ────────────────────────────────────────────────────────────────────────────
// CBOR encoding helpers (module-private)
// ────────────────────────────────────────────────────────────────────────────

// CBOR helpers imported from cbor-utils.ts

// ────────────────────────────────────────────────────────────────────────────
// CBOR decode/encode helpers
// ────────────────────────────────────────────────────────────────────────────

function decodeRelay(cbor: CborSchemaType): Effect.Effect<Relay, SchemaIssue.Issue> {
  return Effect.gen(function* () {
    const items = yield* expectArray(cbor, "Relay");
    const tag = Number(yield* expectUint(items[0]!, "Relay.tag"));
    switch (tag) {
      case 0: {
        const port = items[1]?._tag === CborKinds.UInt ? Number(items[1].num) : undefined;
        const ipv4 = items[2]?._tag === CborKinds.Bytes ? items[2].bytes : undefined;
        const ipv6 = items[3]?._tag === CborKinds.Bytes ? items[3].bytes : undefined;
        return { _tag: RelayKind.SingleHostAddr as const, port, ipv4, ipv6 };
      }
      case 1: {
        const port = items[1]?._tag === CborKinds.UInt ? Number(items[1].num) : undefined;
        const dnsName = yield* expectText(items[2]!, "Relay.SingleHostName.dns");
        return { _tag: RelayKind.SingleHostName as const, port, dnsName };
      }
      case 2: {
        const dnsName = yield* expectText(items[1]!, "Relay.MultiHostName.dns");
        return { _tag: RelayKind.MultiHostName as const, dnsName };
      }
      default:
        return yield* Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(cbor), { message: `Relay: unknown tag ${tag}` }),
        );
    }
  });
}

const encodeRelay = Relay.match({
  [RelayKind.SingleHostAddr]: (r): CborSchemaType =>
    arr(
      uint(0),
      r.port !== undefined ? uint(r.port) : nullVal,
      r.ipv4 !== undefined ? cborBytes(r.ipv4) : nullVal,
      r.ipv6 !== undefined ? cborBytes(r.ipv6) : nullVal,
    ),
  [RelayKind.SingleHostName]: (r): CborSchemaType =>
    arr(uint(1), r.port !== undefined ? uint(r.port) : nullVal, cborText(r.dnsName)),
  [RelayKind.MultiHostName]: (r): CborSchemaType => arr(uint(2), cborText(r.dnsName)),
});

export function decodePoolParams(
  cbor: CborSchemaType,
): Effect.Effect<PoolParams, SchemaIssue.Issue> {
  if (cbor._tag !== CborKinds.Array || cbor.items.length < 9)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), {
        message: "PoolParams: expected 9-element array",
      }),
    );

  const [
    opCbor,
    vrfCbor,
    pledgeCbor,
    costCbor,
    marginCbor,
    rwdCbor,
    ownersCbor,
    relaysCbor,
    metaCbor,
  ] = cbor.items;

  if (opCbor?._tag !== CborKinds.Bytes || opCbor.bytes.length !== 28)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), { message: "PoolParams: invalid operator" }),
    );
  if (vrfCbor?._tag !== CborKinds.Bytes || vrfCbor.bytes.length !== 32)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), {
        message: "PoolParams: invalid vrfKeyHash",
      }),
    );
  if (pledgeCbor?._tag !== CborKinds.UInt)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), { message: "PoolParams: invalid pledge" }),
    );
  if (costCbor?._tag !== CborKinds.UInt)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), { message: "PoolParams: invalid cost" }),
    );
  if (marginCbor?._tag !== CborKinds.Tag || marginCbor.tag !== 30n)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), {
        message: "PoolParams: invalid margin (expected Tag(30))",
      }),
    );
  if (marginCbor.data._tag !== CborKinds.Array || marginCbor.data.items.length !== 2)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), {
        message: "PoolParams: invalid margin array",
      }),
    );
  const marginNum = marginCbor.data.items[0];
  const marginDen = marginCbor.data.items[1];
  if (marginNum?._tag !== CborKinds.UInt || marginDen?._tag !== CborKinds.UInt)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), {
        message: "PoolParams: invalid margin components",
      }),
    );
  if (rwdCbor?._tag !== CborKinds.Bytes)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), {
        message: "PoolParams: invalid rewardAccount",
      }),
    );
  // Owners can be bare Array or Tag(258, Array) in Conway
  const ownerItems = ownersCbor ? getCborSet(ownersCbor) : undefined;
  if (!ownerItems)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), { message: "PoolParams: invalid owners" }),
    );
  // Relays can also be bare Array or Tag(258, Array)
  const relayItems = relaysCbor ? getCborSet(relaysCbor) : undefined;
  if (!relayItems)
    return Effect.fail(
      new SchemaIssue.InvalidValue(Option.some(cbor), { message: "PoolParams: invalid relays" }),
    );

  return Effect.gen(function* () {
    const owners = yield* Effect.all(
      [...ownerItems].map((o) => expectBytes(o, "PoolParams.owner", 28)),
    );
    const relays = yield* Effect.all([...relayItems].map(decodeRelay));

    let metadata: { url: string; hash: Uint8Array } | undefined;
    if (metaCbor && !isNull(metaCbor) && metaCbor._tag === CborKinds.Array) {
      const urlItem = metaCbor.items[0];
      const hashItem = metaCbor.items[1];
      if (urlItem?._tag === CborKinds.Text && hashItem?._tag === CborKinds.Bytes) {
        metadata = { url: urlItem.text, hash: hashItem.bytes };
      }
    }

    return {
      operator: opCbor.bytes,
      vrfKeyHash: vrfCbor.bytes,
      pledge: pledgeCbor.num,
      cost: costCbor.num,
      margin: { numerator: marginNum.num, denominator: marginDen.num },
      rewardAccount: rwdCbor.bytes,
      owners,
      relays,
      metadata,
    };
  });
}

export function encodePoolParams(pp: PoolParams): CborSchemaType {
  return arr(
    cborBytes(pp.operator),
    cborBytes(pp.vrfKeyHash),
    uint(pp.pledge),
    uint(pp.cost),
    { _tag: CborKinds.Tag, tag: 30n, data: arr(uint(pp.margin.numerator), uint(pp.margin.denominator)) },
    cborBytes(pp.rewardAccount),
    arr(...pp.owners.map(cborBytes)),
    arr(...pp.relays.map(encodeRelay)),
    pp.metadata !== undefined
      ? arr(cborText(pp.metadata.url), cborBytes(pp.metadata.hash))
      : nullVal,
  );
}
