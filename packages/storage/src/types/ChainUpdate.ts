/**
 * ChainUpdate — events emitted by ChainDB when the chain state changes.
 */
import { Schema } from "effect";
import { StoredBlock, RealPoint } from "./StoredBlock.ts";

export const ChainUpdate = Schema.TaggedUnion({
  AddBlock: { block: StoredBlock },
  RollBack: { point: RealPoint },
});
export type ChainUpdate = typeof ChainUpdate.Type;

export const AddBlockResult = Schema.TaggedUnion({
  BlockAdded: { point: RealPoint },
  AlreadyExists: {},
  InvalidBlock: { reason: Schema.String },
});
export type AddBlockResult = typeof AddBlockResult.Type;
