import { describe, it, expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import {
  Value,
  ValueBytes,
  emptyValue,
  valueAdd,
  valueSubtract,
  type MultiAssetEntry,
} from "..";

describe("Value schema", () => {
  it.effect("accepts coin-only value", () =>
    Effect.gen(function* () {
      const v = yield* Schema.decodeUnknownEffect(Value)({ coin: 1000000n });
      expect(v.coin).toBe(1000000n);
      expect(v.multiAsset).toBeUndefined();
    }),
  );

  it.effect("accepts multi-asset value", () =>
    Effect.gen(function* () {
      const policy = new Uint8Array(28).fill(0xab);
      const name = new Uint8Array(4).fill(0x01);
      const v = yield* Schema.decodeUnknownEffect(Value)({
        coin: 2000000n,
        multiAsset: [{ policy, assets: [{ name, quantity: 100n }] }],
      });
      expect(v.coin).toBe(2000000n);
      expect(v.multiAsset).toHaveLength(1);
    }),
  );
});

describe("Value CBOR round-trip", () => {
  it.effect("coin-only round-trip", () =>
    Effect.gen(function* () {
      const original = { coin: 5000000n };
      const encoded = yield* Schema.encodeUnknownEffect(ValueBytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(ValueBytes)(encoded);
      expect(decoded.coin).toBe(5000000n);
      expect(decoded.multiAsset).toBeUndefined();
    }),
  );

  it.effect("multi-asset round-trip (canonical sort on encode)", () =>
    Effect.gen(function* () {
      const policy = new Uint8Array(28).fill(0xcd);
      const name1 = new Uint8Array(3).fill(0x41);
      const name2 = new Uint8Array(0);
      // RFC 8949 canonical: shorter length first. name2 (len 0) sorts before
      // name1 (len 3) regardless of insertion order, so the re-decoded
      // assets[] is re-ordered accordingly.
      const original = {
        coin: 3000000n,
        multiAsset: [
          {
            policy,
            assets: [
              { name: name1, quantity: 50n },
              { name: name2, quantity: 1000n },
            ],
          },
        ],
      };
      const encoded = yield* Schema.encodeUnknownEffect(ValueBytes)(original);
      const decoded = yield* Schema.decodeUnknownEffect(ValueBytes)(encoded);
      expect(decoded.coin).toBe(3000000n);
      expect(decoded.multiAsset).toHaveLength(1);
      expect(decoded.multiAsset![0]!.policy).toEqual(policy);
      expect(decoded.multiAsset![0]!.assets).toHaveLength(2);
      expect(decoded.multiAsset![0]!.assets[0]!.name).toEqual(name2);
      expect(decoded.multiAsset![0]!.assets[0]!.quantity).toBe(1000n);
      expect(decoded.multiAsset![0]!.assets[1]!.name).toEqual(name1);
      expect(decoded.multiAsset![0]!.assets[1]!.quantity).toBe(50n);
    }),
  );

  it.effect("encode is insertion-order invariant", () =>
    Effect.gen(function* () {
      const policyA = new Uint8Array(28).fill(0x01);
      const policyB = new Uint8Array(28).fill(0x02);
      const nameX = new Uint8Array([0xaa]);
      const nameY = new Uint8Array([0xbb, 0xcc]);

      const forward: MultiAssetEntry[] = [
        {
          policy: policyB,
          assets: [
            { name: nameY, quantity: 200n },
            { name: nameX, quantity: 100n },
          ],
        },
        {
          policy: policyA,
          assets: [{ name: nameX, quantity: 50n }],
        },
      ];
      const reversed: MultiAssetEntry[] = [
        {
          policy: policyA,
          assets: [{ name: nameX, quantity: 50n }],
        },
        {
          policy: policyB,
          assets: [
            { name: nameX, quantity: 100n },
            { name: nameY, quantity: 200n },
          ],
        },
      ];

      const encFwd = yield* Schema.encodeUnknownEffect(ValueBytes)({
        coin: 1n,
        multiAsset: forward,
      });
      const encRev = yield* Schema.encodeUnknownEffect(ValueBytes)({
        coin: 1n,
        multiAsset: reversed,
      });

      expect(encFwd).toStrictEqual(encRev);
    }),
  );
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 0.0a property tests — `valueAdd` / `valueSubtract` / `mergeMultiAsset`.
//
// Equality yardstick: canonical CBOR bytes. Two Values are "semantically
// equal" iff they encode to identical bytes. `encodeMultiAsset` sorts
// policies + asset names per RFC 8949, but it does NOT dedup duplicate
// policy keys or zero-filter — a user-constructed Value with duplicate
// policies encodes to invalid CBOR (duplicate map keys). To sidestep that,
// arbitraries are pushed through `valueAdd(v, emptyValue())` first, which
// folds duplicates, prunes zero quantities, and drops empty-asset entries.
// Running the normaliser once in the arbitrary lets every downstream
// assertion compare bytes directly without re-normalising.
//
// Inputs are hand-rolled FastCheck arbitraries rather than
// `Schema.toArbitrary(Value)` because `PolicyIdBytes28`'s custom filter
// rejects most Schema-generated byte-arrays — the generator needs to hit the
// exact 28-byte shape every time to avoid running shrinkers on vacuous
// failures.
// ────────────────────────────────────────────────────────────────────────────

const PROPERTY_RUNS = 2_000;

const policyIdArb: FastCheck.Arbitrary<Uint8Array> = FastCheck.uint8Array({
  minLength: 28,
  maxLength: 28,
});

const assetNameArb: FastCheck.Arbitrary<Uint8Array> = FastCheck.uint8Array({
  minLength: 0,
  maxLength: 32,
});

// Bounded non-negative quantities keep both `coin` and `assets[].quantity`
// valid after addition *and* subtraction (we test inverse with `a = x + y`,
// `b = y`, so `a - b = x ≥ 0`). Negative asset quantities are legal on the
// wire (mint supports them) but we stay non-negative here to keep coin
// invariants tight — coin has `Schema.isGreaterThanOrEqualToBigInt(0n)`.
const quantityArb: FastCheck.Arbitrary<bigint> = FastCheck.bigInt({
  min: 0n,
  max: 1_000_000n,
});

const coinArb: FastCheck.Arbitrary<bigint> = FastCheck.bigInt({
  min: 0n,
  max: 1_000_000_000n,
});

const multiAssetEntryArb: FastCheck.Arbitrary<MultiAssetEntry> = FastCheck.record({
  policy: policyIdArb,
  assets: FastCheck.array(
    FastCheck.record({ name: assetNameArb, quantity: quantityArb }),
    { minLength: 0, maxLength: 3 },
  ),
});

const rawValueArb: FastCheck.Arbitrary<Value> = FastCheck.record({
  coin: coinArb,
  multiAsset: FastCheck.option(
    FastCheck.array(multiAssetEntryArb, { minLength: 0, maxLength: 3 }),
    { nil: undefined },
  ),
});

// Every generated Value flows through `valueAdd(_, emptyValue())` so the
// shape is canonical before the property is evaluated: no duplicate policies,
// no duplicate asset names within a policy, no zero-quantity entries, no
// entries with empty `assets[]`.
const valueArb: FastCheck.Arbitrary<Value> = rawValueArb.map((v) => valueAdd(v, emptyValue()));

const encode = (v: Value): Effect.Effect<Uint8Array, unknown> =>
  Schema.encodeUnknownEffect(ValueBytes)(v);

const expectSemanticEq = (a: Value, b: Value): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const [encA, encB] = yield* Effect.all([encode(a), encode(b)]);
    expect(encA).toStrictEqual(encB);
  });

describe("Value arithmetic — FP properties", () => {
  it.effect.prop(
    "valueAdd is associative (mod canonicalisation)",
    { a: valueArb, b: valueArb, c: valueArb },
    ({ a, b, c }) => expectSemanticEq(valueAdd(valueAdd(a, b), c), valueAdd(a, valueAdd(b, c))),
    { fastCheck: { numRuns: PROPERTY_RUNS } },
  );

  it.effect.prop(
    "valueAdd is commutative (mod canonicalisation)",
    { a: valueArb, b: valueArb },
    ({ a, b }) => expectSemanticEq(valueAdd(a, b), valueAdd(b, a)),
    { fastCheck: { numRuns: PROPERTY_RUNS } },
  );

  it.effect.prop(
    "emptyValue() is the right identity of valueAdd",
    { v: valueArb },
    ({ v }) => expectSemanticEq(valueAdd(v, emptyValue()), v),
    { fastCheck: { numRuns: PROPERTY_RUNS } },
  );

  it.effect.prop(
    "emptyValue() is the left identity of valueAdd",
    { v: valueArb },
    ({ v }) => expectSemanticEq(valueAdd(emptyValue(), v), v),
    { fastCheck: { numRuns: PROPERTY_RUNS } },
  );

  it.effect.prop(
    "valueSubtract inverts valueAdd: (a + b) - b = a (non-negative quantities)",
    { a: valueArb, b: valueArb },
    ({ a, b }) => expectSemanticEq(valueSubtract(valueAdd(a, b), b), a),
    { fastCheck: { numRuns: PROPERTY_RUNS } },
  );
});

describe("ValueBytes — CBOR property round-trip", () => {
  it.effect.prop(
    "encode ∘ decode ∘ encode ≡ encode (canonical form is a fixed point)",
    { v: valueArb },
    ({ v }) =>
      Effect.gen(function* () {
        const enc1 = yield* Schema.encodeUnknownEffect(ValueBytes)(v);
        const decoded = yield* Schema.decodeUnknownEffect(ValueBytes)(enc1);
        const enc2 = yield* Schema.encodeUnknownEffect(ValueBytes)(decoded);
        expect(enc2).toStrictEqual(enc1);
      }),
    { fastCheck: { numRuns: PROPERTY_RUNS } },
  );
});
