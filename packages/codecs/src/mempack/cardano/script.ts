import { bytes, tag } from "../primitives";

/**
 * Script = tag(0|1|2) + ShortByteString. The tag encodes the Plutus version
 * (V1 / V2 / V3) but the decoder discards it — only the raw script bytes
 * are returned for storage / forwarding. Consumers that need the version
 * should decode the tag separately.
 */
export const readScript = (
  view: DataView,
  offset: number,
): { scriptBytes: Uint8Array; offset: number } => {
  const { offset: afterTag } = tag.unpack(view, offset);
  const { value: scriptBytes, offset: next } = bytes.unpack(view, afterTag);
  return { scriptBytes, offset: next };
};
