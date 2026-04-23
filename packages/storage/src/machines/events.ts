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

export const ChainDBEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("BLOCK_ADDED"), tip: RealPoint }),
  Schema.Struct({ type: Schema.Literal("IMMUTABILITY_CHECK") }),
  Schema.Struct({ type: Schema.Literal("ROLLBACK"), point: RealPoint }),
  Schema.Struct({ type: Schema.Literal("ERROR"), error: Schema.Defect }),
  Schema.Struct({ type: Schema.Literal("PROMOTE_DONE"), promoted: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("PROMOTE_FAILED"), error: Schema.Defect }),
  Schema.Struct({ type: Schema.Literal("GC_DONE") }),
  Schema.Struct({ type: Schema.Literal("GC_FAILED"), error: Schema.Defect }),
]).pipe(Schema.toTaggedUnion("type"));

export type ChainDBEvent = typeof ChainDBEvent.Type;
