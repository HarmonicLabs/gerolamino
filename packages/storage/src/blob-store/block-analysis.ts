/**
 * Minimal byte-level CBOR walker for post-Byron Cardano blocks.
 *
 * Avoids a full CBOR decode (parseSync is expensive) by skipping items
 * using their wire-format length prefixes. Returns the blockNo (first field
 * of the header body) and the absolute byte offsets + sizes of each
 * transaction body within the block CBOR.
 *
 * Block structure (post-Byron):
 *   [era_tag: uint, [header_array, txBodies: array, witnessSets, auxData, invalidTxs?]]
 * Header structure:
 *   [[blockNo: uint, slot, ...headerBody], kesSig]
 *
 * Byron blocks (era_tag 0 or 1) return `{ blockNo: 0n, txOffsets: [] }` — an
 * expected sentinel the caller can distinguish from post-Byron empty. Malformed
 * CBOR surfaces as a typed `BlockAnalysisParseError` via the Effect-returning
 * entry point `analyzeBlockCbor`. A thin `analyzeBlockCborUnsafe` escape hatch
 * preserves the sync-throwing shape for callers (e.g. the chrome-ext MV3
 * background) that aren't inside an Effect context.
 *
 * Previously both Byron and malformed cases collapsed to the same empty
 * return, silently masking parse bugs as Byron blocks.
 */
import { Effect, Schema } from "effect";

/**
 * Raised when the CBOR walker hits a shape that breaks the post-Byron block
 * invariant (malformed major type, unexpected addInfo, indefinite-length at
 * the outer level, truncated buffer, etc.).
 *
 * `Schema.TaggedErrorClass` rather than a bare `Error`: consumers can
 * pattern-match via `Effect.catchTag("BlockAnalysisParseError", ...)` /
 * `Schema.is(BlockAnalysisParseError)` and the structured `pos` / `reason`
 * fields serialize into any observability surface (logs, EventLog,
 * dashboards) without ad-hoc string parsing.
 */
export class BlockAnalysisParseError extends Schema.TaggedErrorClass<BlockAnalysisParseError>()(
  "BlockAnalysisParseError",
  {
    pos: Schema.Number,
    reason: Schema.String,
  },
) {}

export const TxOffset = Schema.Struct({
  offset: Schema.Number,
  size: Schema.Number,
});
export type TxOffset = typeof TxOffset.Type;

export const BlockAnalysis = Schema.Struct({
  blockNo: Schema.BigInt,
  txOffsets: Schema.Array(TxOffset),
});
export type BlockAnalysis = typeof BlockAnalysis.Type;

const EMPTY: BlockAnalysis = { blockNo: 0n, txOffsets: [] };

/**
 * Read the length argument following a CBOR header byte's addInfo field.
 * Returns { value, bytesRead }. value = -1n for indefinite-length encoding.
 */
function readArg(
  buf: Uint8Array,
  pos: number,
  addInfo: number,
): { value: bigint; bytesRead: number } {
  if (addInfo < 24) return { value: BigInt(addInfo), bytesRead: 0 };
  if (addInfo === 24) return { value: BigInt(buf[pos]!), bytesRead: 1 };
  if (addInfo === 25) {
    const v = (buf[pos]! << 8) | buf[pos + 1]!;
    return { value: BigInt(v), bytesRead: 2 };
  }
  if (addInfo === 26) {
    const dv = new DataView(buf.buffer, buf.byteOffset + pos, 4);
    return { value: BigInt(dv.getUint32(0, false)), bytesRead: 4 };
  }
  if (addInfo === 27) {
    const dv = new DataView(buf.buffer, buf.byteOffset + pos, 8);
    return { value: dv.getBigUint64(0, false), bytesRead: 8 };
  }
  if (addInfo === 31) return { value: -1n, bytesRead: 0 }; // indefinite
  throw new BlockAnalysisParseError({ pos, reason: `invalid CBOR addInfo: ${addInfo}` });
}

/**
 * Skip one CBOR item starting at pos. Returns the new position after the item.
 * Throws on malformed CBOR.
 */
function skipItem(buf: Uint8Array, pos: number): number {
  const header = buf[pos++]!;
  const majorType = header >> 5;
  const addInfo = header & 0x1f;
  const { value, bytesRead } = readArg(buf, pos, addInfo);
  pos += bytesRead;

  switch (majorType) {
    case 0: // uint
    case 1: // negInt
      return pos;
    case 2: // bytes
    case 3: {
      // text
      if (value < 0n) {
        while (buf[pos] !== 0xff) pos = skipItem(buf, pos);
        return pos + 1;
      }
      return pos + Number(value);
    }
    case 4: {
      // array
      if (value < 0n) {
        while (buf[pos] !== 0xff) pos = skipItem(buf, pos);
        return pos + 1;
      }
      const n = Number(value);
      for (let i = 0; i < n; i++) pos = skipItem(buf, pos);
      return pos;
    }
    case 5: {
      // map
      if (value < 0n) {
        while (buf[pos] !== 0xff) {
          pos = skipItem(buf, pos);
          pos = skipItem(buf, pos);
        }
        return pos + 1;
      }
      const n = Number(value);
      for (let i = 0; i < n; i++) {
        pos = skipItem(buf, pos);
        pos = skipItem(buf, pos);
      }
      return pos;
    }
    case 6: // tag
      return skipItem(buf, pos);
    case 7: // simple/float — value already read inline, no further bytes
      return pos;
    default:
      throw new BlockAnalysisParseError({ pos, reason: `unknown CBOR major type: ${majorType}` });
  }
}

/**
 * Read an array header at pos. Returns { count, bytesRead } for definite arrays
 * or throws for non-array / indefinite encodings (which Cardano blocks never use
 * at the outer or txBodies level).
 */
function readArrayHeader(buf: Uint8Array, pos: number): { count: number; bytesRead: number } {
  const header = buf[pos]!;
  const majorType = header >> 5;
  const addInfo = header & 0x1f;
  if (majorType !== 4)
    throw new BlockAnalysisParseError({ pos, reason: `expected array, got major type ${majorType}` });
  const { value, bytesRead } = readArg(buf, pos + 1, addInfo);
  if (value < 0n)
    throw new BlockAnalysisParseError({
      pos,
      reason: "indefinite-length array not supported at block structure",
    });
  return { count: Number(value), bytesRead: 1 + bytesRead };
}

/**
 * Read a uint at pos. Returns the value and bytesRead. Throws if not a uint.
 */
function readUint(buf: Uint8Array, pos: number): { value: bigint; bytesRead: number } {
  const header = buf[pos]!;
  const majorType = header >> 5;
  const addInfo = header & 0x1f;
  if (majorType !== 0)
    throw new BlockAnalysisParseError({ pos, reason: `expected uint, got major type ${majorType}` });
  const { value, bytesRead } = readArg(buf, pos + 1, addInfo);
  return { value, bytesRead: 1 + bytesRead };
}

/**
 * Internal synchronous walker — throws `BlockAnalysisParseError` on
 * malformed CBOR, returns the Byron sentinel on pre-Shelley blocks. Kept
 * sync because the walker is recursive over a byte buffer; threading
 * `Effect` through every `skipItem` frame would add per-byte overhead
 * without buying observability the outer `Effect.try` boundary doesn't
 * already provide.
 *
 * Exported for non-Effect callers (chrome-ext MV3 background) and for
 * tests that assert the throw directly. Effect callers should always use
 * {@link analyzeBlockCbor}.
 */
export const analyzeBlockCborUnsafe = (blockCbor: Uint8Array): BlockAnalysis => {
  let pos = 0;

  // Outer array: [era_tag, block_body_array]
  const outer = readArrayHeader(blockCbor, pos);
  pos += outer.bytesRead;
  if (outer.count < 2) return EMPTY;

  // era_tag
  const era = readUint(blockCbor, pos);
  pos += era.bytesRead;
  if (era.value <= 1n) return EMPTY; // Byron — different block structure

  // block_body: [header, txBodies, witnessSets, auxData, invalidTxs?]
  const body = readArrayHeader(blockCbor, pos);
  pos += body.bytesRead;
  if (body.count < 2) return EMPTY;

  // Header: [[blockNo, slot, ...], kesSig]
  const headerStart = pos;
  const headerArr = readArrayHeader(blockCbor, pos);
  pos += headerArr.bytesRead;
  if (headerArr.count < 2) return EMPTY;

  // headerBody = [blockNo, slot, ...]
  const headerBody = readArrayHeader(blockCbor, pos);
  pos += headerBody.bytesRead;
  if (headerBody.count < 1) return EMPTY;

  const blockNo = readUint(blockCbor, pos);
  const extractedBlockNo = blockNo.value;

  // Skip remaining header body fields + kesSig to land at txBodies start
  pos = skipItem(blockCbor, headerStart);

  // txBodies array
  const txBodies = readArrayHeader(blockCbor, pos);
  pos += txBodies.bytesRead;

  const txOffsets = Array.from({ length: txBodies.count }, (): TxOffset => {
    const start = pos;
    pos = skipItem(blockCbor, pos);
    return { offset: start, size: pos - start };
  });
  return { blockNo: extractedBlockNo, txOffsets };
};

/**
 * Analyse a Cardano block CBOR and extract the block number plus each
 * transaction body's byte offset + size. The returned `BlockAnalysis` is
 * the `BYRON_EMPTY` sentinel for Byron blocks and for any post-Byron block
 * whose outer array is shorter than expected (the usual placeholder shape
 * consumers check with `txOffsets.length === 0`).
 *
 * Malformed CBOR surfaces as a typed `BlockAnalysisParseError` so upstream
 * flows can log / alert / evict offenders instead of silently coalescing
 * parse errors with pre-Shelley blocks — which was the old behaviour.
 */
export const analyzeBlockCbor = (
  blockCbor: Uint8Array,
): Effect.Effect<BlockAnalysis, BlockAnalysisParseError> =>
  Effect.try({
    try: () => analyzeBlockCborUnsafe(blockCbor),
    catch: (cause) =>
      cause instanceof BlockAnalysisParseError
        ? cause
        : new BlockAnalysisParseError({ pos: -1, reason: String(cause) }),
  });
