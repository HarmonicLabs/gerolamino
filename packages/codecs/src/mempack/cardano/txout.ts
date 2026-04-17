import { Schema } from "effect";
import { MemPackDecodeError } from "../MemPackError";
import { bytes, tag } from "../primitives";
import { decodeOnlyMemPackBytes } from "../derive";
import { readAddr28Extra } from "./addr28-extra";
import { readCompactCoin } from "./compact-coin";
import { readCompactValue } from "./compact-value";
import { readCredential } from "./credential";
import { readDatum } from "./datum";
import { readScript } from "./script";
import type {
  DecodedAddr28Extra,
  DecodedCredential,
  DecodedDatumOption,
  DecodedInlineDatum,
  DecodedTxOut,
} from "./schemas";
import {
  DecodedDatumOption as DecodedDatumOptionSchema,
  DecodedInlineDatum as DecodedInlineDatumSchema,
  DecodedTxOut as DecodedTxOutSchema,
  DecodedValue as DecodedValueSchema,
} from "./schemas";

/**
 * Decode a Babbage-era TxOut from Haskell's MemPack binary format — the
 * on-disk layout used by Cardano's UTxO-HD LMDB backend. Matches the
 * reference at `cardano-ledger/eras/babbage/impl/src/Cardano/Ledger/Babbage/TxOut.hs`.
 *
 * Six tag variants:
 *   0: TxOutCompact              = CompactAddr + CompactValue
 *   1: TxOutCompactDH            = CompactAddr + CompactValue + DataHash(32B)
 *   2: TxOut_AddrHash28_AdaOnly  = Credential + Addr28Extra(32B) + CompactCoin
 *   3: TxOut_AddrHash28_AdaOnly_DH32 = variant 2 + DataHash(32B)
 *   4: TxOutCompactDatum         = CompactAddr + CompactValue + BinaryData
 *   5: TxOutCompactRefScript     = CompactAddr + CompactValue + Datum + Script
 *
 * The returned value satisfies the `DecodedTxOut` Schema (see `./schemas.ts`)
 * — compose with `decodedTxOutFromBytes` below when you want a full
 * `Schema.Codec<DecodedTxOut, Uint8Array<ArrayBufferLike>>` for the Effect
 * pipeline (decode-only; encode is not implemented).
 */
export const decodeMemPackTxOut = (buf: Uint8Array): DecodedTxOut => {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const { value: variant, offset: afterTag } = tag.unpack(view, 0);

  switch (variant) {
    case 0: {
      // TxOutCompact
      const { value: address, offset: afterAddr } = bytes.unpack(view, afterTag);
      const { value } = readCompactValue(view, afterAddr);
      return DecodedTxOutSchema.make({ address, value });
    }

    case 1: {
      // TxOutCompactDH
      const { value: address, offset: afterAddr } = bytes.unpack(view, afterTag);
      const { value, offset: afterValue } = readCompactValue(view, afterAddr);
      const hash = new Uint8Array(view.buffer, view.byteOffset + afterValue, 32);
      return DecodedTxOutSchema.make({
        address,
        value,
        datumOption: DecodedDatumOptionSchema.make({ _tag: 0, hash }),
      });
    }

    case 2: {
      // TxOut_AddrHash28_AdaOnly
      const cred = readCredential(view, afterTag);
      const addr28 = readAddr28Extra(view, cred.offset);
      const { coin } = readCompactCoin(view, addr28.offset);
      return DecodedTxOutSchema.make({
        address: buildAddress(addr28, cred),
        value: DecodedValueSchema.make({ coin }),
      });
    }

    case 3: {
      // TxOut_AddrHash28_AdaOnly_DH32
      const cred = readCredential(view, afterTag);
      const addr28 = readAddr28Extra(view, cred.offset);
      const { coin, offset: afterCoin } = readCompactCoin(view, addr28.offset);
      const hash = new Uint8Array(view.buffer, view.byteOffset + afterCoin, 32);
      return DecodedTxOutSchema.make({
        address: buildAddress(addr28, cred),
        value: DecodedValueSchema.make({ coin }),
        datumOption: DecodedDatumOptionSchema.make({ _tag: 0, hash }),
      });
    }

    case 4: {
      // TxOutCompactDatum
      const { value: address, offset: afterAddr } = bytes.unpack(view, afterTag);
      const { value, offset: afterValue } = readCompactValue(view, afterAddr);
      const { value: datumBytes } = bytes.unpack(view, afterValue);
      return DecodedTxOutSchema.make({
        address,
        value,
        datumOption: DecodedDatumOptionSchema.make({ _tag: 1, datum: datumBytes }),
      });
    }

    case 5: {
      // TxOutCompactRefScript
      const { value: address, offset: afterAddr } = bytes.unpack(view, afterTag);
      const { value, offset: afterValue } = readCompactValue(view, afterAddr);
      const { datum, offset: afterDatum } = readDatum(view, afterValue);
      const { scriptBytes } = readScript(view, afterDatum);
      const datumOption = toDatumOption(datum);
      return datumOption === undefined
        ? DecodedTxOutSchema.make({ address, value, scriptRef: scriptBytes })
        : DecodedTxOutSchema.make({ address, value, datumOption, scriptRef: scriptBytes });
    }

    default:
      throw new MemPackDecodeError({
        cause: `BabbageTxOut: unknown MemPack tag ${variant}`,
      });
  }
};

/**
 * Schema-native lift of the Babbage TxOut decoder. Use this inside
 * `Schema.decodeEffect` / `Schema.decodeSync` pipelines — the underlying
 * bytewise decoder is `decodeMemPackTxOut`. Encode is not implemented and
 * fails with a structured `Issue` at runtime.
 */
export const DecodedTxOutFromBytes: Schema.Codec<
  DecodedTxOut,
  Uint8Array<ArrayBufferLike>,
  never,
  never
> = decodeOnlyMemPackBytes("BabbageTxOut", DecodedTxOutSchema, decodeMemPackTxOut);

/**
 * Map the internal `DecodedInlineDatum` (_tag: "none" | "hash" | "inline")
 * to the external `DecodedDatumOption` (_tag: 0 | 1) or `undefined` for the
 * `"none"` case — Babbage's DatumOption has no NoDatum variant; absence is
 * represented by the field being missing on the TxOut.
 */
const toDatumOption = (datum: DecodedInlineDatum): DecodedDatumOption | undefined => {
  if (DecodedInlineDatumSchema.guards.hash(datum)) {
    return DecodedDatumOptionSchema.make({ _tag: 0, hash: datum.hash });
  }
  if (DecodedInlineDatumSchema.guards.inline(datum)) {
    return DecodedDatumOptionSchema.make({ _tag: 1, datum: datum.data });
  }
  return undefined;
};

/**
 * Reconstruct the 57-byte base address from an Addr28Extra + Credential.
 * Header byte layout (Shelley+ base address):
 *   bit 0: network (1=mainnet, 0=testnet)
 *   bit 4: payment credential kind (1=script, 0=key)
 *   bit 5: stake credential kind (1=script, 0=key)
 */
const buildAddress = (
  addr28: DecodedAddr28Extra,
  cred: DecodedCredential,
): Uint8Array => {
  const headerByte =
    (addr28.isMainnet ? 1 : 0) | (addr28.isScript ? 0x10 : 0) | (cred.isScript ? 0x20 : 0);
  const address = new Uint8Array(1 + 28 + 28);
  address[0] = headerByte;
  address.set(addr28.paymentHash, 1);
  address.set(cred.hash, 29);
  return address;
};
