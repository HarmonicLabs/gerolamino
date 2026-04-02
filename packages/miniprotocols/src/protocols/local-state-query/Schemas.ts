import { Schema, SchemaGetter } from "effect";

import { CborSchemaFromBytes, CborKinds, type CborSchemaType } from "cbor-schema";
import { ChainPointSchema, ChainPointType, type ChainPoint } from "../types/ChainPoint";

// ── Application-level types ──

export enum LocalStateQueryMessageType {
  Acquire = "Acquire",
  Acquired = "Acquired",
  Failure = "Failure",
  Query = "Query",
  Result = "Result",
  ReAcquire = "ReAcquire",
  Release = "Release",
  Done = "Done",
}

export const LocalStateQueryMessageTypeSchema = Schema.Enum(LocalStateQueryMessageType);

export const LocalStateQueryMessage = Schema.Union([
  Schema.TaggedStruct(LocalStateQueryMessageType.Acquire, {
    point: Schema.optional(ChainPointSchema),
  }),
  Schema.TaggedStruct(LocalStateQueryMessageType.Acquired, {}),
  Schema.TaggedStruct(LocalStateQueryMessageType.Failure, {
    failure: Schema.Uint8Array,
  }),
  Schema.TaggedStruct(LocalStateQueryMessageType.Query, {
    query: Schema.Uint8Array,
  }),
  Schema.TaggedStruct(LocalStateQueryMessageType.Result, {
    result: Schema.Uint8Array,
  }),
  Schema.TaggedStruct(LocalStateQueryMessageType.ReAcquire, {
    point: Schema.optional(ChainPointSchema),
  }),
  Schema.TaggedStruct(LocalStateQueryMessageType.Release, {}),
  Schema.TaggedStruct(LocalStateQueryMessageType.Done, {}),
]).pipe(Schema.toTaggedUnion("_tag"));

export type LocalStateQueryMessageT = Schema.Schema.Type<typeof LocalStateQueryMessage>;

// ── CBOR helpers for ChainPoint ──

function decodeChainPoint(node: CborSchemaType): ChainPoint {
  if (node._tag !== CborKinds.Array) throw new Error("Expected CBOR array for ChainPoint");
  if (node.items.length === 0) return { _tag: ChainPointType.Origin as const };
  const slot = node.items[0];
  const hash = node.items[1];
  if (slot?._tag !== CborKinds.UInt) throw new Error("Expected uint for slot");
  if (hash?._tag !== CborKinds.Bytes) throw new Error("Expected bytes for hash");
  return { _tag: ChainPointType.RealPoint as const, slot: Number(slot.num), hash: hash.bytes };
}

function encodeChainPoint(point: ChainPoint): CborSchemaType {
  if (point._tag === ChainPointType.Origin) return { _tag: CborKinds.Array, items: [] };
  return {
    _tag: CborKinds.Array,
    items: [
      { _tag: CborKinds.UInt, num: BigInt(point.slot) },
      { _tag: CborKinds.Bytes, bytes: point.hash },
    ],
  };
}

/** Try to decode an optional ChainPoint from a CBOR item (undefined if absent) */
function decodeOptionalChainPoint(node: CborSchemaType | undefined): ChainPoint | undefined {
  if (node === undefined) return undefined;
  // CBOR null / undefined → absent
  if (node._tag === CborKinds.Simple && (node.value === null || node.value === undefined)) return undefined;
  return decodeChainPoint(node);
}

function encodeOptionalChainPoint(point: ChainPoint | undefined): CborSchemaType {
  if (point === undefined) return { _tag: CborKinds.Simple, value: null };
  return encodeChainPoint(point);
}

// ── CBOR wire format ──
// [0, point?]   — Acquire
// [1]           — Acquired
// [2, failure]  — Failure
// [3, query]    — Query
// [4, result]   — Result
// [5, point?]   — ReAcquire
// [6]           — Release
// [7]           — Done

export const LocalStateQueryMessageBytes = CborSchemaFromBytes.pipe(
  Schema.decodeTo(LocalStateQueryMessage, {
    decode: SchemaGetter.transform((cbor: CborSchemaType) => {
      if (cbor._tag !== CborKinds.Array) throw new Error("Expected CBOR array");
      const tag = cbor.items[0];
      if (tag?._tag !== CborKinds.UInt) throw new Error("Expected uint tag");
      switch (Number(tag.num)) {
        case 0:
          return {
            _tag: LocalStateQueryMessageType.Acquire as const,
            point: decodeOptionalChainPoint(cbor.items[1]),
          };
        case 1:
          return { _tag: LocalStateQueryMessageType.Acquired as const };
        case 2: {
          const failure = cbor.items[1];
          if (failure?._tag !== CborKinds.Bytes) throw new Error("Expected bytes for failure");
          return { _tag: LocalStateQueryMessageType.Failure as const, failure: failure.bytes };
        }
        case 3: {
          const query = cbor.items[1];
          if (query?._tag !== CborKinds.Bytes) throw new Error("Expected bytes for query");
          return { _tag: LocalStateQueryMessageType.Query as const, query: query.bytes };
        }
        case 4: {
          const result = cbor.items[1];
          if (result?._tag !== CborKinds.Bytes) throw new Error("Expected bytes for result");
          return { _tag: LocalStateQueryMessageType.Result as const, result: result.bytes };
        }
        case 5:
          return {
            _tag: LocalStateQueryMessageType.ReAcquire as const,
            point: decodeOptionalChainPoint(cbor.items[1]),
          };
        case 6:
          return { _tag: LocalStateQueryMessageType.Release as const };
        case 7:
          return { _tag: LocalStateQueryMessageType.Done as const };
        default:
          throw new Error(`Unknown LocalStateQuery tag: ${Number(tag.num)}`);
      }
    }),
    encode: SchemaGetter.transform(
      LocalStateQueryMessage.match({
        Acquire: (m): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [
            { _tag: CborKinds.UInt, num: 0n },
            encodeOptionalChainPoint(m.point),
          ],
        }),
        Acquired: (): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [{ _tag: CborKinds.UInt, num: 1n }],
        }),
        Failure: (m): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [
            { _tag: CborKinds.UInt, num: 2n },
            { _tag: CborKinds.Bytes, bytes: m.failure },
          ],
        }),
        Query: (m): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [
            { _tag: CborKinds.UInt, num: 3n },
            { _tag: CborKinds.Bytes, bytes: m.query },
          ],
        }),
        Result: (m): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [
            { _tag: CborKinds.UInt, num: 4n },
            { _tag: CborKinds.Bytes, bytes: m.result },
          ],
        }),
        ReAcquire: (m): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [
            { _tag: CborKinds.UInt, num: 5n },
            encodeOptionalChainPoint(m.point),
          ],
        }),
        Release: (): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [{ _tag: CborKinds.UInt, num: 6n }],
        }),
        Done: (): CborSchemaType => ({
          _tag: CborKinds.Array,
          items: [{ _tag: CborKinds.UInt, num: 7n }],
        }),
      }),
    ),
  }),
);
