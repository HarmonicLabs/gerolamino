import { describe, expect, it } from "vitest";
import {
  decodeMemPackTxOut,
  length,
  MemPackDecodeError,
  packToUint8Array,
  tag,
  varLen,
} from "../index";

/**
 * Build a MemPack byte sequence from variable-sized field encodings.
 * Each element is already encoded; we just concatenate.
 */
const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  parts.reduce((pos, p) => (out.set(p, pos), pos + p.byteLength), 0);
  return out;
};

const shortByteString = (bytes: Uint8Array): Uint8Array =>
  concat(packToUint8Array(length, bytes.byteLength), bytes);

describe("mempack/cardano/txout", () => {
  it("decodes tag 0: TxOutCompact with AdaOnly CompactValue", () => {
    const address = Uint8Array.from({ length: 29 }, (_, i) => i);
    const coin = 5_000_000n;
    // Outer tag 0 + CompactAddr (ShortByteString) + CompactValue AdaOnly (tag 0 + VarLen coin)
    const buf = concat(
      packToUint8Array(tag, 0),
      shortByteString(address),
      packToUint8Array(tag, 0),
      packToUint8Array(varLen, coin),
    );
    const txOut = decodeMemPackTxOut(buf);
    expect(txOut.address).toStrictEqual(address);
    expect(txOut.value.coin).toBe(coin);
    expect(txOut.value.multiAsset).toBeUndefined();
    expect(txOut.datumOption).toBeUndefined();
    expect(txOut.scriptRef).toBeUndefined();
  });

  it("decodes tag 1: TxOutCompactDH (address + value + 32-byte datum hash)", () => {
    const address = Uint8Array.from({ length: 29 }, (_, i) => i + 1);
    const hash = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i);
    const coin = 1_500_000n;
    const buf = concat(
      packToUint8Array(tag, 1),
      shortByteString(address),
      packToUint8Array(tag, 0), // CompactValue tag: AdaOnly
      packToUint8Array(varLen, coin),
      hash,
    );
    const txOut = decodeMemPackTxOut(buf);
    expect(txOut.address).toStrictEqual(address);
    expect(txOut.value.coin).toBe(coin);
    expect(txOut.datumOption?._tag).toBe(0);
    if (txOut.datumOption?._tag === 0) {
      expect(txOut.datumOption.hash).toStrictEqual(hash);
    }
  });

  it("decodes tag 2: AdaOnly compact (credential + addr28extra + coin)", () => {
    // Credential (tag 1 = KeyHash) + 28-byte hash
    const stakeHash = Uint8Array.from({ length: 28 }, (_, i) => i + 0x40);
    // Addr28Extra: 32 bytes; word 3 (bytes 24-31) carries the flags.
    // bit 0 = 1 (Key, inverted so isScript=false), bit 1 = 1 (mainnet)
    const addr28 = new Uint8Array(32);
    for (let i = 0; i < 28; i++) addr28[i] = 0x10 + i;
    const dv = new DataView(addr28.buffer);
    dv.setBigUint64(24, 0x0000_0000_0000_0003n, true); // bits 0+1 set
    // CompactCoin: tag 0 + VarLen coin
    const coin = 9_999_999n;
    const buf = concat(
      packToUint8Array(tag, 2),
      packToUint8Array(tag, 1), // Credential: KeyHash
      stakeHash,
      addr28,
      packToUint8Array(tag, 0), // CompactCoin tag
      packToUint8Array(varLen, coin),
    );
    const txOut = decodeMemPackTxOut(buf);
    // Address = header byte + 28 payment hash + 28 stake hash
    expect(txOut.address.byteLength).toBe(1 + 28 + 28);
    // Header: mainnet=1 (bit 0), payment isScript=false (bit 4 = 0),
    // stake credential isScript=false (bit 5 = 0) → 0b0000_0001 = 0x01
    expect(txOut.address[0]).toBe(0x01);
    expect(txOut.value.coin).toBe(coin);
    expect(txOut.value.multiAsset).toBeUndefined();
  });

  it("rejects unknown outer TxOut tag", () => {
    const buf = packToUint8Array(tag, 99);
    expect(() => decodeMemPackTxOut(buf)).toThrow(MemPackDecodeError);
  });

  it("rejects unknown CompactValue tag inside a valid outer TxOut", () => {
    const address = Uint8Array.from({ length: 29 }, (_, i) => i);
    const buf = concat(
      packToUint8Array(tag, 0),
      shortByteString(address),
      packToUint8Array(tag, 7), // Unknown CompactValue tag
    );
    expect(() => decodeMemPackTxOut(buf)).toThrow(MemPackDecodeError);
  });
});
