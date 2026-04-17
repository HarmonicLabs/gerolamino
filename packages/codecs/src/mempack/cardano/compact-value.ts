import { MemPackDecodeError } from "../MemPackError";
import { bytes, tag, varLen } from "../primitives";
import type { DecodedPolicy, DecodedValue } from "./schemas";
import {
  DecodedAsset as DecodedAssetSchema,
  DecodedPolicy as DecodedPolicySchema,
  DecodedValue as DecodedValueSchema,
} from "./schemas";

/**
 * CompactValue = tag(0)=AdaOnly | tag(1)=MultiAsset. The AdaOnly variant is
 * a single `VarLen coin`; the MultiAsset variant packs Coin + asset count +
 * a flat ShortByteString carrying a compact representation of the per-policy
 * asset list (see `decodeCompactMultiAsset`).
 *
 * Note: CompactValue's tags are INDEPENDENT of BabbageTxOut's tags. Inside
 * the MultiAsset variant, the coin is a raw VarLen without its own tag
 * (matching Haskell's `packCompactCoinM = packM (VarLen c)`).
 *
 * Returns a `DecodedValue` — the Schema-typed struct from `./schemas.ts`.
 */
export const readCompactValue = (
  view: DataView,
  offset: number,
): { value: DecodedValue; offset: number } => {
  const { value: tagValue, offset: afterTag } = tag.unpack(view, offset);

  if (tagValue === 0) {
    // AdaOnly: VarLen coin (no tag prefix)
    const { value: coin, offset: next } = varLen.unpack(view, afterTag);
    return { value: DecodedValueSchema.make({ coin }), offset: next };
  }

  if (tagValue === 1) {
    // MultiAsset: VarLen coin + VarLen count + ShortByteString rep
    const { value: coin, offset: afterCoin } = varLen.unpack(view, afterTag);
    const { value: numAssets, offset: afterCount } = varLen.unpack(view, afterCoin);
    const { value: rep, offset: next } = bytes.unpack(view, afterCount);
    const multiAsset = decodeCompactMultiAsset(rep, Number(numAssets));
    return { value: DecodedValueSchema.make({ coin, multiAsset }), offset: next };
  }

  throw new MemPackDecodeError({ cause: `CompactValue: unknown tag ${tagValue}` });
};

/**
 * Decode the compact multi-asset ShortByteString layout (Haskell `ByteArray`).
 *
 * The ShortByteString has five contiguous regions:
 *   A: n × Word64-LE quantities            (offsets 0..8n)
 *   B: n × Word16-LE policy offsets        (offsets 8n..10n)
 *   C: n × Word16-LE asset-name offsets    (offsets 10n..12n)
 *   D: unique policy IDs (28 bytes each)
 *   E: unique asset names (variable)
 *
 * Offsets in B and C are ABSOLUTE byte offsets into the ShortByteString.
 * Policy IDs are 28 bytes (blake2b-224). Asset-name lengths are computed
 * from the delta between consecutive unique name offsets (with `rep.length`
 * as the implicit sentinel after the last one).
 */
const decodeCompactMultiAsset = (
  rep: Uint8Array,
  numAssets: number,
): readonly DecodedPolicy[] => {
  if (numAssets === 0) return [];

  // Safety: the ABC regions must fit within rep. If not, the enclosing coin
  // was likely parsed correctly but the multi-asset payload is malformed —
  // return empty rather than throw so callers can still extract the coin.
  if (numAssets * 12 > rep.length) return [];

  const dv = new DataView(rep.buffer, rep.byteOffset, rep.byteLength);

  // Read raw triples: (pidOffset, anameOffset, quantity)
  const triples = Array.from({ length: numAssets }, (_, i) => ({
    quantity: dv.getBigUint64(i * 8, true),
    pidOff: dv.getUint16(numAssets * 8 + i * 2, true),
    anameOff: dv.getUint16(numAssets * 10 + i * 2, true),
  }));

  // Compute asset-name lengths from the unique sorted offsets.
  // ES2025: Array.prototype.toSorted produces a sorted copy (no mutation).
  const uniqueAnameOffs = [...new Set(triples.map((t) => t.anameOff))].toSorted((a, b) => a - b);
  const anameLenMap = new Map<number, number>(
    uniqueAnameOffs.map((off, i) => [
      off,
      (uniqueAnameOffs[i + 1] ?? rep.length) - off,
    ]),
  );

  // Group triples by policy-id offset.
  const policyMap = new Map<number, { policy: Uint8Array; assets: Array<typeof DecodedAssetSchema.Type> }>();
  for (const { pidOff, anameOff, quantity } of triples) {
    if (pidOff + 28 > rep.length) continue;
    let entry = policyMap.get(pidOff);
    if (!entry) {
      entry = { policy: rep.slice(pidOff, pidOff + 28), assets: [] };
      policyMap.set(pidOff, entry);
    }
    const nameLen = anameLenMap.get(anameOff) ?? 0;
    const name =
      nameLen > 0 && anameOff + nameLen <= rep.length
        ? rep.slice(anameOff, anameOff + nameLen)
        : new Uint8Array(0);
    entry.assets.push(DecodedAssetSchema.make({ name, quantity }));
  }

  return [...policyMap.values()].map((entry) =>
    DecodedPolicySchema.make({ policy: entry.policy, assets: entry.assets }),
  );
};
