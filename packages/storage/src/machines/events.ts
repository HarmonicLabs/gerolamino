/**
 * XState event types shared across storage machines.
 *
 * Uses Effect Schema.Union + toTaggedUnion("type") for type-safe pattern
 * matching via .match(), .guards, and .isAnyOf() — same convention as
 * ChainSyncMessage and CryptoRequest, but with "type" as discriminator
 * for XState compatibility.
 */
import { Schema } from "effect";
import { RealPoint } from "../types/StoredBlock.ts";
import { LedgerStateSnapshot } from "../types/LedgerState.ts";
import { MempoolTx } from "../types/Mempool.ts";

// ---------------------------------------------------------------------------
// ChainDB events
// ---------------------------------------------------------------------------

export const ChainDBEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("BLOCK_RECEIVED") }),
  Schema.Struct({ type: Schema.Literal("CHAIN_SELECTED"), tip: RealPoint }),
  Schema.Struct({ type: Schema.Literal("IMMUTABILITY_CHECK") }),
  Schema.Struct({ type: Schema.Literal("COPY_COMPLETE") }),
  Schema.Struct({ type: Schema.Literal("GC_COMPLETE") }),
  Schema.Struct({ type: Schema.Literal("SNAPSHOT_WRITTEN") }),
  Schema.Struct({ type: Schema.Literal("ROLLBACK"), point: RealPoint }),
  Schema.Struct({ type: Schema.Literal("ERROR"), error: Schema.Defect }),
]).pipe(Schema.toTaggedUnion("type"));

export type ChainDBEvent = typeof ChainDBEvent.Type;

// ---------------------------------------------------------------------------
// Mempool events
// ---------------------------------------------------------------------------

export const MempoolEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("TX_SUBMITTED"), tx: MempoolTx }),
  Schema.Struct({ type: Schema.Literal("BLOCK_APPLIED"), txIds: Schema.Array(Schema.Uint8Array) }),
  Schema.Struct({ type: Schema.Literal("REVALIDATE"), ledgerState: LedgerStateSnapshot }),
]).pipe(Schema.toTaggedUnion("type"));

export type MempoolEvent = typeof MempoolEvent.Type;
