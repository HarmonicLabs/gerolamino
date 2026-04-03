/**
 * Binary TLV protocol for Gerolamo bootstrap streaming.
 * No Effect dependency - pure functions over Uint8Array and DataView.
 * Shared by both Effect-TS and raw browser clients.
 */

// ---------------------------------------------------------------------------
// Message Tags
// ---------------------------------------------------------------------------

export const MessageTag = {
  Init: 0x01,
  Block: 0x02,
  LedgerState: 0x03,
  LedgerMeta: 0x04,
  LmdbEntries: 0x05,
  Progress: 0x06,
  Complete: 0xff,
} as const;

export type MessageTag = (typeof MessageTag)[keyof typeof MessageTag];

// ---------------------------------------------------------------------------
// Message Types
// ---------------------------------------------------------------------------

export type InitMessage = {
  readonly tag: typeof MessageTag.Init;
  readonly protocolMagic: number;
  readonly snapshotSlot: bigint;
  readonly totalChunks: number;
  readonly totalBlocks: number;
  readonly totalLmdbEntries: number;
  readonly lmdbDatabases: ReadonlyArray<string>;
};

export type BlockMessage = {
  readonly tag: typeof MessageTag.Block;
  readonly chunkNo: number;
  readonly slotNo: bigint;
  readonly headerHash: Uint8Array;
  readonly headerOffset: number;
  readonly headerSize: number;
  readonly crc: number;
  readonly blockCbor: Uint8Array;
};

export type LedgerStateMessage = {
  readonly tag: typeof MessageTag.LedgerState;
  readonly payload: Uint8Array;
};

export type LedgerMetaMessage = {
  readonly tag: typeof MessageTag.LedgerMeta;
  readonly payload: Uint8Array;
};

export type LmdbEntriesMessage = {
  readonly tag: typeof MessageTag.LmdbEntries;
  readonly dbName: string;
  readonly count: number;
  readonly entries: ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }>;
};

export type ProgressMessage = {
  readonly tag: typeof MessageTag.Progress;
  readonly phase: string;
  readonly current: number;
  readonly total: number;
};

export type CompleteMessage = {
  readonly tag: typeof MessageTag.Complete;
};

export type BootstrapMessage =
  | InitMessage
  | BlockMessage
  | LedgerStateMessage
  | LedgerMetaMessage
  | LmdbEntriesMessage
  | ProgressMessage
  | CompleteMessage;

// ---------------------------------------------------------------------------
// TLV Frame: [tag: u8][length: u32 BE][payload: u8[length]]
// ---------------------------------------------------------------------------

const HEADER_SIZE = 5;

export function encodeFrame(tag: MessageTag, payload: Uint8Array): Uint8Array {
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

export function decodeBlock(payload: Uint8Array): BlockMessage {
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
    tag: MessageTag.Block,
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
// LmdbEntries Payload Encode/Decode
// [dbNameLen: u16 BE][dbName: utf8][count: u32 BE]
// [entries: (keyLen: u16 BE, key, valLen: u32 BE, val)*]
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeLmdbBatch(
  dbName: string,
  entries: ReadonlyArray<{ readonly key: Uint8Array; readonly value: Uint8Array }>,
): Uint8Array {
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

export function decodeLmdbBatch(payload: Uint8Array): LmdbEntriesMessage {
  const dv = new DataView(payload.buffer, payload.byteOffset);
  let off = 0;
  const nameLen = dv.getUint16(off, false);
  off += 2;
  const dbName = textDecoder.decode(payload.subarray(off, off + nameLen));
  off += nameLen;
  const count = dv.getUint32(off, false);
  off += 4;
  const entries: { key: Uint8Array; value: Uint8Array }[] = [];
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
  return { tag: MessageTag.LmdbEntries, dbName, count, entries };
}

// ---------------------------------------------------------------------------
// Init Payload - Simple JSON encoding (small message)
// ---------------------------------------------------------------------------

export function encodeInit(init: Omit<InitMessage, "tag">): Uint8Array {
  return textEncoder.encode(
    JSON.stringify({
      protocolMagic: init.protocolMagic,
      snapshotSlot: init.snapshotSlot.toString(),
      totalChunks: init.totalChunks,
      totalBlocks: init.totalBlocks,
      totalLmdbEntries: init.totalLmdbEntries,
      lmdbDatabases: init.lmdbDatabases,
    }),
  );
}

export function decodeInit(payload: Uint8Array): InitMessage {
  const json = JSON.parse(textDecoder.decode(payload));
  return {
    tag: MessageTag.Init,
    protocolMagic: json.protocolMagic,
    snapshotSlot: BigInt(json.snapshotSlot),
    totalChunks: json.totalChunks,
    totalBlocks: json.totalBlocks,
    totalLmdbEntries: json.totalLmdbEntries,
    lmdbDatabases: json.lmdbDatabases,
  };
}

// ---------------------------------------------------------------------------
// Progress Payload - Simple JSON encoding (small message)
// ---------------------------------------------------------------------------

export function encodeProgress(phase: string, current: number, total: number): Uint8Array {
  return textEncoder.encode(JSON.stringify({ phase, current, total }));
}

export function decodeProgress(payload: Uint8Array): ProgressMessage {
  const json = JSON.parse(textDecoder.decode(payload));
  return { tag: MessageTag.Progress, phase: json.phase, current: json.current, total: json.total };
}

// ---------------------------------------------------------------------------
// Top-level decode: frame → BootstrapMessage
// ---------------------------------------------------------------------------

export function decodeFrame(frame: Uint8Array): BootstrapMessage {
  const tagByte = frame[0];
  if (tagByte === undefined) throw new Error("Empty frame");
  const dv = new DataView(frame.buffer, frame.byteOffset);
  const payloadLen = dv.getUint32(1, false);
  const payload = frame.subarray(HEADER_SIZE, HEADER_SIZE + payloadLen);

  switch (tagByte) {
    case MessageTag.Init:
      return decodeInit(payload);
    case MessageTag.Block:
      return decodeBlock(payload);
    case MessageTag.LedgerState:
      return { tag: MessageTag.LedgerState, payload: payload.slice() };
    case MessageTag.LedgerMeta:
      return { tag: MessageTag.LedgerMeta, payload: payload.slice() };
    case MessageTag.LmdbEntries:
      return decodeLmdbBatch(payload);
    case MessageTag.Progress:
      return decodeProgress(payload);
    case MessageTag.Complete:
      return { tag: MessageTag.Complete };
    default:
      throw new Error(`Unknown message tag: 0x${tagByte.toString(16)}`);
  }
}

// ---------------------------------------------------------------------------
// Utility: concatenate two Uint8Arrays
// ---------------------------------------------------------------------------

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}
