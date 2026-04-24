/**
 * ChainDB lifecycle events — tagged union dispatched through a
 * `Queue<ChainDBEvent>` inside `ChainDBLive`.
 *
 * `_tag` discriminator + PascalCase names match the rest of the
 * codebase (`miniprotocols`, `ledger`, `consensus`). The reducer in
 * `./chaindb.ts` exhausts every case via `ChainDBEvent.match`.
 */
import { Schema } from "effect";
import { RealPoint } from "../types/StoredBlock.ts";

export const ChainDBEvent = Schema.Union([
  Schema.TaggedStruct("BlockAdded", { tip: RealPoint }),
  Schema.TaggedStruct("Rollback", { point: RealPoint }),
  Schema.TaggedStruct("ErrorRaised", { error: Schema.Defect }),
  Schema.TaggedStruct("PromoteDone", { promoted: Schema.Number }),
  Schema.TaggedStruct("PromoteFailed", { error: Schema.Defect }),
  Schema.TaggedStruct("GcDone", {}),
  Schema.TaggedStruct("GcFailed", { error: Schema.Defect }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type ChainDBEvent = typeof ChainDBEvent.Type;
