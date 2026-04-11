import { Schema, SchemaGetter } from "effect";
import { ChainPointFromCbor, ChainPointSchema } from "./ChainPoint";

// ── Application-level type ──

export const ChainTipSchema = Schema.Struct({
  point: ChainPointSchema,
  blockNo: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type ChainTip = typeof ChainTipSchema.Type;

// ── CBOR wire format ──
// tip = [point, blockNo] where point is [] or [slot, hash]

export const ChainTipFromCbor = Schema.Tuple([
  ChainPointFromCbor,
  Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
]).pipe(
  Schema.decodeTo(ChainTipSchema, {
    decode: SchemaGetter.transform((tuple) => ({
      point: tuple[0],
      blockNo: tuple[1],
    })),
    encode: SchemaGetter.transform((tip) => [tip.point, tip.blockNo]),
  }),
);
