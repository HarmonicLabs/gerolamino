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
  /** `dropped` is the number of volatile blocks the rollback removed from
   *  SQL. The reducer decrements `volatileLength` by this so the
   *  threshold check in `BlockAdded` resumes from the correct baseline.
   *  Without it, a rollback past the volatile-window boundary would
   *  leave `volatileLength` permanently inflated and incorrectly
   *  re-trigger promotion on every subsequent block. */
  Schema.TaggedStruct("Rollback", { point: RealPoint, dropped: Schema.Int }),
  Schema.TaggedStruct("ErrorRaised", { error: Schema.Defect }),
  Schema.TaggedStruct("PromoteDone", { promoted: Schema.Number }),
  Schema.TaggedStruct("PromoteFailed", { error: Schema.Defect }),
  Schema.TaggedStruct("GcDone", {}),
  Schema.TaggedStruct("GcFailed", { error: Schema.Defect }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type ChainDBEvent = typeof ChainDBEvent.Type;
