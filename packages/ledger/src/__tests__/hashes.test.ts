import { describe, it, expect } from "@effect/vitest";
import { Effect, Equal, Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import {
  Hash28,
  Hash32,
  Signature,
  KeyHash,
  ScriptHash,
  PolicyId,
  PoolKeyHash,
  VRFKeyHash,
  TxId,
  DataHash,
  AuxDataHash,
  ScriptDataHash,
  DocHash,
  Hash28Bytes,
  Hash32Bytes,
  SignatureBytes,
  KeyHashBytes,
  ScriptHashBytes,
  PolicyIdBytes,
  PoolKeyHashBytes,
  VRFKeyHashBytes,
  TxIdBytes,
  DataHashBytes,
  AuxDataHashBytes,
  ScriptDataHashBytes,
  DocHashBytes,
  Bytes28,
  Bytes32,
} from "..";

describe("Hash28 schema", () => {
  it.effect("accepts 28-byte Uint8Array", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(28).fill(0xab);
      const hash = yield* Schema.decodeUnknownEffect(Hash28)(bytes);
      expect(hash.length).toBe(28);
    }),
  );

  it.effect("rejects wrong length", () =>
    Effect.gen(function* () {
      const exit = yield* Schema.decodeUnknownEffect(Hash28)(new Uint8Array(27)).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("Hash32 schema", () => {
  it.effect("accepts 32-byte Uint8Array", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(32).fill(0xcd);
      const hash = yield* Schema.decodeUnknownEffect(Hash32)(bytes);
      expect(hash.length).toBe(32);
    }),
  );

  it.effect("rejects wrong length", () =>
    Effect.gen(function* () {
      const exit = yield* Schema.decodeUnknownEffect(Hash32)(new Uint8Array(31)).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  );
});

describe("Signature schema", () => {
  it.effect("accepts 64-byte Uint8Array", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(64).fill(0xef);
      const sig = yield* Schema.decodeUnknownEffect(Signature)(bytes);
      expect(sig.length).toBe(64);
    }),
  );
});

describe("Stacked brands", () => {
  it.effect("KeyHash is a Hash28 subtype", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(28).fill(0x01);
      const kh = yield* Schema.decodeUnknownEffect(KeyHash)(bytes);
      expect(kh.length).toBe(28);
    }),
  );

  it.effect("TxId is a Hash32 subtype", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(32).fill(0x02);
      const txId = yield* Schema.decodeUnknownEffect(TxId)(bytes);
      expect(txId.length).toBe(32);
    }),
  );
});

describe("Bytes28 / Bytes32 (unbranded checked)", () => {
  it.effect("Bytes28 rejects wrong length", () =>
    Effect.gen(function* () {
      const exit = yield* Schema.decodeUnknownEffect(Bytes28)(new Uint8Array(10)).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("Bytes32 accepts correct length", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(32).fill(0xff);
      const result = yield* Schema.decodeUnknownEffect(Bytes32)(bytes);
      expect(result.length).toBe(32);
    }),
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Byte-wise Equal — `Equal.equals` goes through the `ArrayBuffer.isView` path
// for branded Uint8Array, so structural comparison works without wrapping.
// ────────────────────────────────────────────────────────────────────────────

describe("Equal.equals on branded Uint8Array", () => {
  it("same bytes compare equal across brands", () => {
    const a = new Uint8Array(28).fill(0x01);
    const b = new Uint8Array(28).fill(0x01);
    expect(Equal.equals(a, b)).toBe(true);
  });

  it("different bytes compare not equal", () => {
    const a = new Uint8Array(28).fill(0x01);
    const b = new Uint8Array(28).fill(0x02);
    expect(Equal.equals(a, b)).toBe(false);
  });

  it("different lengths compare not equal", () => {
    expect(Equal.equals(new Uint8Array(28), new Uint8Array(32))).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property-based round-trip — derived Arbitrary via the `toArbitrary`
// annotation generates fixed-length Uint8Array; the CBOR codec encodes/decodes
// byte-exact. One property per branded type.
// ────────────────────────────────────────────────────────────────────────────

type BrandedCodec = {
  readonly name: string;
  readonly schema: Schema.Codec<Uint8Array, Uint8Array, never, never>;
  readonly codec: Schema.Codec<Uint8Array, Uint8Array, never, never>;
  readonly length: number;
};

const brandedCodecs: ReadonlyArray<BrandedCodec> = [
  { name: "Hash28", schema: Hash28, codec: Hash28Bytes, length: 28 },
  { name: "Hash32", schema: Hash32, codec: Hash32Bytes, length: 32 },
  { name: "Signature", schema: Signature, codec: SignatureBytes, length: 64 },
  { name: "KeyHash", schema: KeyHash, codec: KeyHashBytes, length: 28 },
  { name: "ScriptHash", schema: ScriptHash, codec: ScriptHashBytes, length: 28 },
  { name: "PolicyId", schema: PolicyId, codec: PolicyIdBytes, length: 28 },
  { name: "PoolKeyHash", schema: PoolKeyHash, codec: PoolKeyHashBytes, length: 28 },
  { name: "VRFKeyHash", schema: VRFKeyHash, codec: VRFKeyHashBytes, length: 32 },
  { name: "TxId", schema: TxId, codec: TxIdBytes, length: 32 },
  { name: "DataHash", schema: DataHash, codec: DataHashBytes, length: 32 },
  { name: "AuxDataHash", schema: AuxDataHash, codec: AuxDataHashBytes, length: 32 },
  { name: "ScriptDataHash", schema: ScriptDataHash, codec: ScriptDataHashBytes, length: 32 },
  { name: "DocHash", schema: DocHash, codec: DocHashBytes, length: 32 },
];

describe.each(brandedCodecs)(
  "$name derived property round-trip",
  ({ name, schema, codec, length }) => {
    it(`${name} arbitrary produces ${length}-byte values`, () => {
      const arb = Schema.toArbitrary(schema);
      FastCheck.assert(
        FastCheck.property(arb, (bytes) => bytes.length === length),
        { numRuns: 200 },
      );
    });

    it(`${name} equivalence reports structural equality`, () => {
      const arb = Schema.toArbitrary(schema);
      const eq = Schema.toEquivalence(schema);
      FastCheck.assert(
        FastCheck.property(arb, (bytes) => eq(bytes, new Uint8Array(bytes))),
        { numRuns: 200 },
      );
    });

    it(`${name} CBOR round-trip via cborBytesCodec is identity`, () => {
      const arb = Schema.toArbitrary(schema);
      FastCheck.assert(
        FastCheck.property(arb, (bytes) => {
          const encoded = Schema.encodeUnknownSync(codec)(bytes);
          const decoded = Schema.decodeUnknownSync(codec)(encoded);
          return Equal.equals(bytes, decoded);
        }),
        { numRuns: 200 },
      );
    });
  },
);

// ────────────────────────────────────────────────────────────────────────────
// Spot-check fixed-byte round-trips (smoke tests independent of fast-check)
// ────────────────────────────────────────────────────────────────────────────

describe("Hash CBOR round-trip (fixed fixtures)", () => {
  it.effect("Hash28 round-trip", () =>
    Effect.gen(function* () {
      const original = new Uint8Array(28).fill(0xaa);
      const encoded = yield* Schema.encodeUnknownEffect(Hash28Bytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(Hash28Bytes)(encoded);
      expect(decoded).toEqual(original);
    }),
  );

  it.effect("Hash32 round-trip", () =>
    Effect.gen(function* () {
      const original = new Uint8Array(32).fill(0xbb);
      const encoded = yield* Schema.encodeUnknownEffect(Hash32Bytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(Hash32Bytes)(encoded);
      expect(decoded).toEqual(original);
    }),
  );

  it.effect("TxId round-trip", () =>
    Effect.gen(function* () {
      const original = new Uint8Array(32).fill(0xcc);
      const encoded = yield* Schema.encodeUnknownEffect(TxIdBytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(TxIdBytes)(encoded);
      expect(decoded).toEqual(original);
    }),
  );
});
