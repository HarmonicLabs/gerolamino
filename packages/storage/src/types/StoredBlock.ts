/**
 * StoredBlock — the block type stored in ImmutableDB and VolatileDB.
 *
 * Contains both the decoded header fields (for queries by slot/hash)
 * and the raw CBOR bytes (for forwarding to peers).
 */
import { Schema } from "effect";

export const RealPoint = Schema.Struct({
  slot: Schema.BigInt,
  hash: Schema.Uint8Array, // 32 bytes
});
export type RealPoint = Schema.Schema.Type<typeof RealPoint>;

export const StoredBlock = Schema.Struct({
  slot: Schema.BigInt,
  hash: Schema.Uint8Array, // 32B header hash
  prevHash: Schema.optional(Schema.Uint8Array), // 32B, undefined for genesis
  blockNo: Schema.BigInt,
  blockSizeBytes: Schema.Number,
  blockCbor: Schema.Uint8Array, // raw block CBOR for re-encoding/forwarding
});
export type StoredBlock = Schema.Schema.Type<typeof StoredBlock>;
