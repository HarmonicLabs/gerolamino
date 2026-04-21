import { Schema } from "effect";
import type * as FastCheck from "effect/testing/FastCheck";
import { positionalArrayLink, toCodecCborBytes, withCborLink } from "codecs";
import { Bytes28, Bytes32, isByteLength } from "../core/hashes.ts";
import { MAX_WORD64, UnitInterval } from "../core/primitives.ts";

// ────────────────────────────────────────────────────────────────────────────
// Relay — how to reach a stake pool
// CBOR: [0, port/null, ipv4/null, ipv6/null] | [1, port/null, dnsName] | [2, dnsName]
// CDDL: port = 0..65535 (uint16), ipv4 = bytes .size 4, ipv6 = bytes .size 16,
//       dnsName = tstr .size (0..128)
// ────────────────────────────────────────────────────────────────────────────

export enum RelayKind {
  SingleHostAddr = 0,
  SingleHostName = 1,
  MultiHostName = 2,
}

const Port = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 2 ** 16 - 1 })),
  Schema.annotate({
    toArbitrary: () => (fc: typeof FastCheck) => fc.integer({ min: 0, max: 65535 }),
  }),
);
const IPv4 = Schema.Uint8Array.pipe(
  Schema.check(isByteLength(4)),
  Schema.annotate({
    toArbitrary: () => (fc: typeof FastCheck) => fc.uint8Array({ minLength: 4, maxLength: 4 }),
  }),
);
const IPv6 = Schema.Uint8Array.pipe(
  Schema.check(isByteLength(16)),
  Schema.annotate({
    toArbitrary: () => (fc: typeof FastCheck) => fc.uint8Array({ minLength: 16, maxLength: 16 }),
  }),
);
const DnsName = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(128)),
  Schema.annotate({ toArbitrary: () => (fc: typeof FastCheck) => fc.string({ maxLength: 128 }) }),
);

export const Relay = Schema.Union([
  Schema.TaggedStruct(RelayKind.SingleHostAddr, {
    port: Schema.NullOr(Port),
    ipv4: Schema.NullOr(IPv4),
    ipv6: Schema.NullOr(IPv6),
  }),
  Schema.TaggedStruct(RelayKind.SingleHostName, {
    port: Schema.NullOr(Port),
    dnsName: DnsName,
  }),
  Schema.TaggedStruct(RelayKind.MultiHostName, {
    dnsName: DnsName,
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type Relay = typeof Relay.Type;

// ────────────────────────────────────────────────────────────────────────────
// Pool Metadata — positional [url, metadataHash]
// ────────────────────────────────────────────────────────────────────────────

export const PoolMetadata = Schema.Struct({
  url: Schema.String.pipe(
    Schema.check(Schema.isMaxLength(128)),
    Schema.annotate({
      toArbitrary: () => (fc: typeof FastCheck) => fc.string({ maxLength: 128 }),
    }),
  ),
  hash: Bytes32,
}).pipe(withCborLink((walked) => positionalArrayLink(["url", "hash"])(walked)));
export type PoolMetadata = typeof PoolMetadata.Type;

// ────────────────────────────────────────────────────────────────────────────
// PoolParams — stake pool registration parameters
// CBOR: positional 9-element array
//   [operator, vrfKeyhash, pledge, cost, margin, rewardAccount,
//    poolOwners, relays, poolMetadata | null]
// ────────────────────────────────────────────────────────────────────────────

// Reward account is a 29-byte Shelley stake-credential address
// (1 header byte + 28-byte credential hash). CDDL: bytes .size 29.
export const RewardAccount = Schema.Uint8Array.pipe(
  Schema.check(isByteLength(29)),
  Schema.annotate({
    toArbitrary: () => (fc: typeof FastCheck) => fc.uint8Array({ minLength: 29, maxLength: 29 }),
  }),
);

export const PoolParams = Schema.Struct({
  operator: Bytes28,
  vrfKeyHash: Bytes32,
  pledge: Schema.BigInt.pipe(
    Schema.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: MAX_WORD64 })),
  ),
  cost: Schema.BigInt.pipe(
    Schema.check(Schema.isBetweenBigInt({ minimum: 0n, maximum: MAX_WORD64 })),
  ),
  margin: UnitInterval,
  rewardAccount: RewardAccount,
  owners: Schema.Array(Bytes28),
  relays: Schema.Array(Relay),
  metadata: Schema.NullOr(PoolMetadata),
}).pipe(
  withCborLink((walked) =>
    positionalArrayLink([
      "operator",
      "vrfKeyHash",
      "pledge",
      "cost",
      "margin",
      "rewardAccount",
      "owners",
      "relays",
      "metadata",
    ])(walked),
  ),
);
export type PoolParams = typeof PoolParams.Type;

// ────────────────────────────────────────────────────────────────────────────
// Derived codecs
// ────────────────────────────────────────────────────────────────────────────

export const PoolParamsBytes = toCodecCborBytes(PoolParams);
export const RelayBytes = toCodecCborBytes(Relay);
