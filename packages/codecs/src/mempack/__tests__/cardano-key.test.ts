import { describe, expect, it } from "vitest";
import { decodeMemPackKey, MemPackDecodeError } from "../index";

describe("mempack/cardano/key", () => {
  it("decodes a 34-byte UTxO key", () => {
    const txId = Uint8Array.from({ length: 32 }, (_, i) => i);
    const buf = new Uint8Array(34);
    buf.set(txId, 0);
    // TxIx = 42, big-endian Word16
    buf[32] = 0x00;
    buf[33] = 0x2a;

    const { txId: decodedTxId, txIx } = decodeMemPackKey(buf);
    expect(decodedTxId).toStrictEqual(txId);
    expect(txIx).toBe(42);
  });

  it("decodes TxIx as big-endian (not little-endian)", () => {
    const buf = new Uint8Array(34);
    // TxIx bytes 0x01 0x02 → BE: 0x0102 = 258; LE would be 0x0201 = 513
    buf[32] = 0x01;
    buf[33] = 0x02;
    expect(decodeMemPackKey(buf).txIx).toBe(0x0102);
  });

  it("rejects non-34-byte inputs", () => {
    expect(() => decodeMemPackKey(new Uint8Array(33))).toThrow(MemPackDecodeError);
    expect(() => decodeMemPackKey(new Uint8Array(35))).toThrow(MemPackDecodeError);
    expect(() => decodeMemPackKey(new Uint8Array(0))).toThrow(MemPackDecodeError);
  });
});
