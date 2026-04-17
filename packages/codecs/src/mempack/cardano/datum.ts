import { MemPackDecodeError } from "../MemPackError";
import { bytes, tag } from "../primitives";
import type { DecodedInlineDatum } from "./schemas";
import { DecodedInlineDatum as DecodedInlineDatumSchema } from "./schemas";

/**
 * Datum = tag(0)=NoDatum | tag(1)=DatumHash+32B | tag(2)=Inline+ShortByteString.
 *
 * Returns a `DecodedInlineDatum` — the internal Schema-typed tagged union
 * (see `./schemas.ts`). The caller (TxOut decoder) converts this to the
 * externally-visible `DecodedDatumOption` shape; the internal vs. external
 * _tag numbering differs because Babbage's DatumOption only has two variants
 * (Hash/Inline — "none" is represented by the field being absent).
 */
export const readDatum = (
  view: DataView,
  offset: number,
): { datum: DecodedInlineDatum; offset: number } => {
  const { value: tagValue, offset: afterTag } = tag.unpack(view, offset);

  if (tagValue === 0) {
    return {
      datum: DecodedInlineDatumSchema.make({ _tag: "none" }),
      offset: afterTag,
    };
  }
  if (tagValue === 1) {
    return {
      datum: DecodedInlineDatumSchema.make({
        _tag: "hash",
        hash: new Uint8Array(view.buffer, view.byteOffset + afterTag, 32),
      }),
      offset: afterTag + 32,
    };
  }
  if (tagValue === 2) {
    const { value: data, offset: next } = bytes.unpack(view, afterTag);
    return {
      datum: DecodedInlineDatumSchema.make({ _tag: "inline", data }),
      offset: next,
    };
  }
  throw new MemPackDecodeError({ cause: `Datum: unknown tag ${tagValue}` });
};
