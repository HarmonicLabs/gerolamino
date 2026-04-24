/**
 * Binary TLV protocol for Gerolamo bootstrap streaming.
 * Schema-based message types with `_tag` discriminant + wire-format encoding.
 */
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Message Kind (Schema discriminant)
// ---------------------------------------------------------------------------

export enum BootstrapMessageKind {
  Init = "Init",
  Block = "Block",
  LedgerState = "LedgerState",
  LedgerMeta = "LedgerMeta",
  BlobEntries = "BlobEntries",
  Progress = "Progress",
  Complete = "Complete",
}

export const BootstrapMessageKindSchema = Schema.Enum(BootstrapMessageKind);

// ---------------------------------------------------------------------------
// Blob entry — shared shape for BlobEntries wire payload
// ---------------------------------------------------------------------------

export const BlobEntry = Schema.Struct({
  key: Schema.Uint8Array,
  value: Schema.Uint8Array,
});
export type BlobEntry = typeof BlobEntry.Type;

// ---------------------------------------------------------------------------
// Schema.TaggedUnion — gives .match(), .guards, .isAnyOf() for free
// ---------------------------------------------------------------------------

export const BootstrapMessage = Schema.Union([
  Schema.TaggedStruct(BootstrapMessageKind.Init, {
    protocolMagic: Schema.Number,
    snapshotSlot: Schema.BigInt,
    totalChunks: Schema.Number,
    totalBlocks: Schema.Number,
    totalBlobEntries: Schema.Number,
    blobPrefixes: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct(BootstrapMessageKind.Block, {
    chunkNo: Schema.Number,
    slotNo: Schema.BigInt,
    headerHash: Schema.Uint8Array,
    headerOffset: Schema.Number,
    headerSize: Schema.Number,
    crc: Schema.Number,
    blockCbor: Schema.Uint8Array,
  }),
  Schema.TaggedStruct(BootstrapMessageKind.LedgerState, { payload: Schema.Uint8Array }),
  Schema.TaggedStruct(BootstrapMessageKind.LedgerMeta, { payload: Schema.Uint8Array }),
  Schema.TaggedStruct(BootstrapMessageKind.BlobEntries, {
    dbName: Schema.String,
    count: Schema.Number,
    entries: Schema.Array(BlobEntry),
  }),
  Schema.TaggedStruct(BootstrapMessageKind.Progress, {
    phase: Schema.String,
    current: Schema.Number,
    total: Schema.Number,
  }),
  Schema.TaggedStruct(BootstrapMessageKind.Complete, {}),
]).pipe(Schema.toTaggedUnion("_tag"));

export type BootstrapMessageType = typeof BootstrapMessage.Type;

// ---------------------------------------------------------------------------
// Wire Tags — numeric TLV frame tags for binary encoding/decoding
// ---------------------------------------------------------------------------

export const WireTag = {
  Init: 0x01,
  Block: 0x02,
  LedgerState: 0x03,
  LedgerMeta: 0x04,
  BlobEntries: 0x05,
  Progress: 0x06,
  Complete: 0xff,
} as const;

export type WireTag = (typeof WireTag)[keyof typeof WireTag];

// ---------------------------------------------------------------------------
// TLV Frame: [tag: u8][length: u32 BE][payload: u8[length]]
// ---------------------------------------------------------------------------

const HEADER_SIZE = 5;

export function encodeFrame(tag: WireTag, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(HEADER_SIZE + payload.length);
  const dv = new DataView(frame.buffer, frame.byteOffset);
  dv.setUint8(0, tag);
  dv.setUint32(1, payload.length, false);
  frame.set(payload, HEADER_SIZE);
  return frame;
}

export function extractFrames(buffer: Uint8Array): {
  readonly frames: ReadonlyArray<Uint8Array>;
  readonly remaining: Uint8Array;
} {
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset + HEADER_SIZE <= buffer.length) {
    const dv = new DataView(buffer.buffer, buffer.byteOffset + offset);
    const payloadLen = dv.getUint32(1, false);
    const frameLen = HEADER_SIZE + payloadLen;
    if (offset + frameLen > buffer.length) break;
    frames.push(buffer.subarray(offset, offset + frameLen));
    offset += frameLen;
  }
  return { frames, remaining: buffer.subarray(offset) };
}

// ---------------------------------------------------------------------------
// Block Payload Encode/Decode
// [chunkNo: u16 BE][slot: u64 BE][hash: 32 bytes][headerOffset: u16 BE]
// [headerSize: u16 BE][crc: u32 BE][blockCbor: rest]
// ---------------------------------------------------------------------------

const BLOCK_HEADER_SIZE = 2 + 8 + 32 + 2 + 2 + 4; // 50 bytes

export function encodeBlock(block: {
  readonly chunkNo: number;
  readonly slotNo: bigint;
  readonly headerHash: Uint8Array;
  readonly headerOffset: number;
  readonly headerSize: number;
  readonly crc: number;
  readonly blockCbor: Uint8Array;
}): Uint8Array {
  const payload = new Uint8Array(BLOCK_HEADER_SIZE + block.blockCbor.length);
  const dv = new DataView(payload.buffer, payload.byteOffset);
  let off = 0;
  dv.setUint16(off, block.chunkNo, false);
  off += 2;
  dv.setBigUint64(off, block.slotNo, false);
  off += 8;
  payload.set(block.headerHash, off);
  off += 32;
  dv.setUint16(off, block.headerOffset, false);
  off += 2;
  dv.setUint16(off, block.headerSize, false);
  off += 2;
  dv.setUint32(off, block.crc, false);
  off += 4;
  payload.set(block.blockCbor, off);
  return payload;
}

export function decodeBlock(payload: Uint8Array) {
  const dv = new DataView(payload.buffer, payload.byteOffset);
  let off = 0;
  const chunkNo = dv.getUint16(off, false);
  off += 2;
  const slotNo = dv.getBigUint64(off, false);
  off += 8;
  const headerHash = payload.slice(off, off + 32);
  off += 32;
  const headerOffset = dv.getUint16(off, false);
  off += 2;
  const headerSize = dv.getUint16(off, false);
  off += 2;
  const crc = dv.getUint32(off, false);
  off += 4;
  const blockCbor = payload.slice(off);
  return {
    _tag: BootstrapMessageKind.Block as const,
    chunkNo,
    slotNo,
    headerHash,
    headerOffset,
    headerSize,
    crc,
    blockCbor,
  };
}

// ---------------------------------------------------------------------------
// BlobEntries Payload Encode/Decode
// [dbNameLen: u16 BE][dbName: utf8][count: u32 BE]
// [entries: (keyLen: u16 BE, key, valLen: u32 BE, val)*]
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeBlobBatch(dbName: string, entries: ReadonlyArray<BlobEntry>): Uint8Array {
  const nameBytes = textEncoder.encode(dbName);
  let totalSize = 2 + nameBytes.length + 4;
  for (const e of entries) {
    totalSize += 2 + e.key.length + 4 + e.value.length;
  }
  const payload = new Uint8Array(totalSize);
  const dv = new DataView(payload.buffer, payload.byteOffset);
  let off = 0;
  dv.setUint16(off, nameBytes.length, false);
  off += 2;
  payload.set(nameBytes, off);
  off += nameBytes.length;
  dv.setUint32(off, entries.length, false);
  off += 4;
  for (const e of entries) {
    dv.setUint16(off, e.key.length, false);
    off += 2;
    payload.set(e.key, off);
    off += e.key.length;
    dv.setUint32(off, e.value.length, false);
    off += 4;
    payload.set(e.value, off);
    off += e.value.length;
  }
  return payload;
}

export function decodeBlobBatch(payload: Uint8Array) {
  const dv = new DataView(payload.buffer, payload.byteOffset);
  let off = 0;
  const nameLen = dv.getUint16(off, false);
  off += 2;
  const dbName = textDecoder.decode(payload.subarray(off, off + nameLen));
  off += nameLen;
  const count = dv.getUint32(off, false);
  off += 4;
  const entries: Array<BlobEntry> = [];
  for (let i = 0; i < count; i++) {
    const keyLen = dv.getUint16(off, false);
    off += 2;
    const key = payload.slice(off, off + keyLen);
    off += keyLen;
    const valLen = dv.getUint32(off, false);
    off += 4;
    const value = payload.slice(off, off + valLen);
    off += valLen;
    entries.push({ key, value });
  }
  return { _tag: BootstrapMessageKind.BlobEntries as const, dbName, count, entries };
}

// ---------------------------------------------------------------------------
// Init Payload - Simple JSON encoding (small message)
// ---------------------------------------------------------------------------

export function encodeInit(init: {
  readonly protocolMagic: number;
  readonly snapshotSlot: bigint;
  readonly totalChunks: number;
  readonly totalBlocks: number;
  readonly totalBlobEntries: number;
  readonly blobPrefixes: ReadonlyArray<string>;
}): Uint8Array {
  return textEncoder.encode(
    JSON.stringify({
      protocolMagic: init.protocolMagic,
      snapshotSlot: init.snapshotSlot.toString(),
      totalChunks: init.totalChunks,
      totalBlocks: init.totalBlocks,
      totalBlobEntries: init.totalBlobEntries,
      blobPrefixes: init.blobPrefixes,
    }),
  );
}

/**
 * Wire shape for the Init JSON payload — `snapshotSlot` is a string over the
 * wire because JSON has no bigint. Validated via `Schema.decodeUnknownSync`
 * before lifting into the bigint domain type so a malformed frame produces a
 * precise `Schema.SchemaError` instead of a silent `BigInt(undefined)` throw.
 */
const InitWireShape = Schema.Struct({
  protocolMagic: Schema.Number,
  snapshotSlot: Schema.String,
  totalChunks: Schema.Number,
  totalBlocks: Schema.Number,
  totalBlobEntries: Schema.Number,
  blobPrefixes: Schema.Array(Schema.String),
});
const decodeInitShape = Schema.decodeUnknownSync(InitWireShape);

export function decodeInit(payload: Uint8Array) {
  const validated = decodeInitShape(JSON.parse(textDecoder.decode(payload)));
  return {
    _tag: BootstrapMessageKind.Init as const,
    protocolMagic: validated.protocolMagic,
    snapshotSlot: BigInt(validated.snapshotSlot),
    totalChunks: validated.totalChunks,
    totalBlocks: validated.totalBlocks,
    totalBlobEntries: validated.totalBlobEntries,
    blobPrefixes: validated.blobPrefixes,
  };
}

// ---------------------------------------------------------------------------
// Progress Payload - Simple JSON encoding (small message)
// ---------------------------------------------------------------------------

export function encodeProgress(phase: string, current: number, total: number): Uint8Array {
  return textEncoder.encode(JSON.stringify({ phase, current, total }));
}

const ProgressWireShape = Schema.Struct({
  phase: Schema.String,
  current: Schema.Number,
  total: Schema.Number,
});
const decodeProgressShape = Schema.decodeUnknownSync(ProgressWireShape);

export function decodeProgress(payload: Uint8Array) {
  const validated = decodeProgressShape(JSON.parse(textDecoder.decode(payload)));
  return {
    _tag: BootstrapMessageKind.Progress as const,
    phase: validated.phase,
    current: validated.current,
    total: validated.total,
  };
}

// ---------------------------------------------------------------------------
// Symmetric encode: BootstrapMessage → TLV frame
// ---------------------------------------------------------------------------

export function encodeMessage(msg: BootstrapMessageType): Uint8Array {
  return BootstrapMessage.match({
    Init: (m) => encodeFrame(WireTag.Init, encodeInit(m)),
    Block: (m) => encodeFrame(WireTag.Block, encodeBlock(m)),
    LedgerState: (m) => encodeFrame(WireTag.LedgerState, m.payload),
    LedgerMeta: (m) => encodeFrame(WireTag.LedgerMeta, m.payload),
    BlobEntries: (m) => encodeFrame(WireTag.BlobEntries, encodeBlobBatch(m.dbName, m.entries)),
    Progress: (m) => encodeFrame(WireTag.Progress, encodeProgress(m.phase, m.current, m.total)),
    Complete: () => encodeFrame(WireTag.Complete, new Uint8Array(0)),
  })(msg);
}

// ---------------------------------------------------------------------------
// Top-level decode: frame → BootstrapMessage
// ---------------------------------------------------------------------------

export function decodeFrame(frame: Uint8Array): BootstrapMessageType {
  const tagByte = frame[0];
  if (tagByte === undefined) throw new Error("Empty frame");
  const dv = new DataView(frame.buffer, frame.byteOffset);
  const payloadLen = dv.getUint32(1, false);
  const payload = frame.subarray(HEADER_SIZE, HEADER_SIZE + payloadLen);

  switch (tagByte) {
    case WireTag.Init:
      return decodeInit(payload);
    case WireTag.Block:
      return decodeBlock(payload);
    case WireTag.LedgerState:
      // `payload` is already a subarray view of the frame buffer; pre-refactor
      // copied the entire 50–200 MB ledger-state blob here just to drop the
      // reference to the wider buffer. The receiver holds the frame's own
      // scope and only reads the bytes, so the subarray is safe.
      return { _tag: BootstrapMessageKind.LedgerState as const, payload };
    case WireTag.LedgerMeta:
      return { _tag: BootstrapMessageKind.LedgerMeta as const, payload };
    case WireTag.BlobEntries:
      return decodeBlobBatch(payload);
    case WireTag.Progress:
      return decodeProgress(payload);
    case WireTag.Complete:
      return { _tag: BootstrapMessageKind.Complete as const };
    default:
      throw new Error(`Unknown message tag: 0x${tagByte.toString(16).padStart(2, "0")}`);
  }
}

// Re-export the shared variadic primitive from codecs under the legacy name.
export { concat as concatBytes } from "codecs";
