import { MemPackDecodeError } from "../MemPackError";
import { tag, varLen } from "../primitives";

/**
 * CompactCoin = tag(0) + VarLen(Word64). Used by Babbage TxOut variants 2/3
 * (AdaOnly). The tag is always 0 — the single-variant discriminator is kept
 * for forward compatibility with future Coin extensions.
 */
export const readCompactCoin = (
  view: DataView,
  offset: number,
): { coin: bigint; offset: number } => {
  const { value: tagValue, offset: afterTag } = tag.unpack(view, offset);
  if (tagValue !== 0) {
    throw new MemPackDecodeError({ cause: `CompactCoin: expected tag 0, got ${tagValue}` });
  }
  const { value: coin, offset: next } = varLen.unpack(view, afterTag);
  return { coin, offset: next };
};
