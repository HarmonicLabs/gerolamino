import { describe, it, expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { CborKinds, type CborSchemaType } from "codecs";
import {
  TxIn,
  TxOut,
  TxBody,
  Tx,
  TxWitnessSet,
  TxInBytes,
  TxOutBytes,
  TxBodyBytes,
  decodeTxIn,
  encodeTxIn,
  decodeTxOut,
  encodeTxOut,
  decodeTxBody,
  encodeTxBody,
  DatumOption,
  DatumOptionKind,
} from "..";

const txId32 = new Uint8Array(32).fill(0xaa);
const addr29 = new Uint8Array(29).fill(0x61); // enterprise address header + 28 bytes

describe("TxIn schema + CBOR", () => {
  it.effect("accepts valid TxIn", () =>
    Effect.gen(function* () {
      const txIn = yield* Schema.decodeUnknownEffect(TxIn)({ txId: txId32, index: 0n });
      expect(txIn.index).toBe(0n);
    }),
  );

  it.effect("TxIn CBOR round-trip", () =>
    Effect.gen(function* () {
      const original = { txId: txId32, index: 3n };
      const encoded = yield* Schema.encodeUnknownEffect(TxInBytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(TxInBytes)(encoded);
      expect(decoded.txId).toEqual(txId32);
      expect(decoded.index).toBe(3n);
    }),
  );
});

describe("TxOut CBOR round-trip", () => {
  it.effect("simple TxOut (coin only, no datum)", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Map,
        entries: [
          { k: { _tag: CborKinds.UInt, num: 0n }, v: { _tag: CborKinds.Bytes, bytes: addr29 } },
          { k: { _tag: CborKinds.UInt, num: 1n }, v: { _tag: CborKinds.UInt, num: 2000000n } },
        ],
      };
      const decoded = yield* decodeTxOut(cbor);
      expect(decoded.address).toEqual(addr29);
      expect(decoded.value.coin).toBe(2000000n);
      expect(decoded.datumOption).toBeUndefined();
      expect(decoded.scriptRef).toBeUndefined();

      const reEncoded = yield* encodeTxOut(decoded);
      expect(reEncoded).toEqual(cbor);
    }),
  );

  it.effect("TxOut with datum hash", () =>
    Effect.gen(function* () {
      const datumHash = new Uint8Array(32).fill(0xdd);
      const cbor: CborSchemaType = {
        _tag: CborKinds.Map,
        entries: [
          { k: { _tag: CborKinds.UInt, num: 0n }, v: { _tag: CborKinds.Bytes, bytes: addr29 } },
          { k: { _tag: CborKinds.UInt, num: 1n }, v: { _tag: CborKinds.UInt, num: 5000000n } },
          {
            k: { _tag: CborKinds.UInt, num: 2n },
            v: {
              _tag: CborKinds.Array,
              items: [
                { _tag: CborKinds.UInt, num: 0n },
                { _tag: CborKinds.Bytes, bytes: datumHash },
              ],
            },
          },
        ],
      };
      const decoded = yield* decodeTxOut(cbor);
      expect(decoded.datumOption?._tag).toBe(DatumOptionKind.DatumHash);
    }),
  );
});

describe("TxBody CBOR round-trip", () => {
  it.effect("minimal TxBody (inputs, outputs, fee)", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Map,
        entries: [
          {
            k: { _tag: CborKinds.UInt, num: 0n },
            v: {
              _tag: CborKinds.Array,
              items: [
                {
                  _tag: CborKinds.Array,
                  items: [
                    { _tag: CborKinds.Bytes, bytes: txId32 },
                    { _tag: CborKinds.UInt, num: 0n },
                  ],
                },
              ],
            },
          },
          {
            k: { _tag: CborKinds.UInt, num: 1n },
            v: {
              _tag: CborKinds.Array,
              items: [
                {
                  _tag: CborKinds.Map,
                  entries: [
                    {
                      k: { _tag: CborKinds.UInt, num: 0n },
                      v: { _tag: CborKinds.Bytes, bytes: addr29 },
                    },
                    {
                      k: { _tag: CborKinds.UInt, num: 1n },
                      v: { _tag: CborKinds.UInt, num: 1500000n },
                    },
                  ],
                },
              ],
            },
          },
          { k: { _tag: CborKinds.UInt, num: 2n }, v: { _tag: CborKinds.UInt, num: 200000n } },
        ],
      };
      const decoded = yield* decodeTxBody(cbor);
      expect(decoded.inputs).toHaveLength(1);
      expect(decoded.inputs[0]!.txId).toEqual(txId32);
      expect(decoded.outputs).toHaveLength(1);
      expect(decoded.outputs[0]!.value.coin).toBe(1500000n);
      expect(decoded.fee).toBe(200000n);
      expect(decoded.ttl).toBeUndefined();
      expect(decoded.certs).toBeUndefined();
    }),
  );

  it.effect("TxBody with ttl and validity start", () =>
    Effect.gen(function* () {
      const cbor: CborSchemaType = {
        _tag: CborKinds.Map,
        entries: [
          {
            k: { _tag: CborKinds.UInt, num: 0n },
            v: {
              _tag: CborKinds.Array,
              items: [
                {
                  _tag: CborKinds.Array,
                  items: [
                    { _tag: CborKinds.Bytes, bytes: txId32 },
                    { _tag: CborKinds.UInt, num: 1n },
                  ],
                },
              ],
            },
          },
          {
            k: { _tag: CborKinds.UInt, num: 1n },
            v: {
              _tag: CborKinds.Array,
              items: [
                {
                  _tag: CborKinds.Map,
                  entries: [
                    {
                      k: { _tag: CborKinds.UInt, num: 0n },
                      v: { _tag: CborKinds.Bytes, bytes: addr29 },
                    },
                    {
                      k: { _tag: CborKinds.UInt, num: 1n },
                      v: { _tag: CborKinds.UInt, num: 3000000n },
                    },
                  ],
                },
              ],
            },
          },
          { k: { _tag: CborKinds.UInt, num: 2n }, v: { _tag: CborKinds.UInt, num: 180000n } },
          { k: { _tag: CborKinds.UInt, num: 3n }, v: { _tag: CborKinds.UInt, num: 50000000n } },
          { k: { _tag: CborKinds.UInt, num: 8n }, v: { _tag: CborKinds.UInt, num: 49000000n } },
        ],
      };
      const decoded = yield* decodeTxBody(cbor);
      expect(decoded.ttl).toBe(50000000n);
      expect(decoded.validityStart).toBe(49000000n);
    }),
  );

  it.effect("TxBody encode then decode round-trip", () =>
    Effect.gen(function* () {
      const original = {
        inputs: [{ txId: txId32, index: 0n }],
        outputs: [{ address: addr29, value: { coin: 2000000n } }],
        fee: 200000n,
        ttl: 60000000n,
      };
      const encoded = yield* Schema.encodeUnknownEffect(TxBodyBytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(TxBodyBytes)(encoded);
      expect(decoded.inputs).toHaveLength(1);
      expect(decoded.inputs[0]!.txId).toEqual(txId32);
      expect(decoded.outputs[0]!.value.coin).toBe(2000000n);
      expect(decoded.fee).toBe(200000n);
      expect(decoded.ttl).toBe(60000000n);
    }),
  );
});

describe("DatumOption", () => {
  it("guards work", () => {
    const opt = { _tag: DatumOptionKind.DatumHash as const, hash: new Uint8Array(32) };
    expect(DatumOption.guards[DatumOptionKind.DatumHash](opt)).toBe(true);
    expect(DatumOption.guards[DatumOptionKind.InlineDatum](opt)).toBe(false);
  });
});
