import { describe, it } from "@effect/vitest";
import { Equal } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { CborKinds, type CborValue, encodeSync, parseSync } from "../index";

// ────────────────────────────────────────────────────────────────────────────
// Property tests for CBOR Layer 1 — `parseSync` + `encodeSync` on random
// CBOR IR values and on random byte streams. These complement the example-
// based `identity.test.ts` / `parse.test.ts` / `encode.test.ts` suites.
//
// The hand-rolled `cborValueArb` below generates *valid* CborValue trees
// with controlled recursion depth — `Schema.toArbitrary(CborValue)` would
// work too, but recursive Schema arbitraries bias toward termination rather
// than structural diversity. A shaped arbitrary gives tighter coverage of
// deep composites (Array/Map/Tag/nested-bytes chunks) per run.
//
// Note on `addInfos`: the parser preserves the original wire-format width
// when re-encoding. To express a "value round-trips" law we compare the
// IR with addInfos stripped — the user-visible value is the `num`/`text`/
// `bytes`/`items`/`entries` payload, not the wire-format hint.
// ────────────────────────────────────────────────────────────────────────────

const stripAddInfos = (v: CborValue): CborValue => {
  switch (v._tag) {
    case CborKinds.UInt:
    case CborKinds.NegInt:
      return { _tag: v._tag, num: v.num };
    case CborKinds.Bytes:
      return { _tag: v._tag, bytes: v.bytes };
    case CborKinds.Text:
      return { _tag: v._tag, text: v.text };
    case CborKinds.Array:
      return { _tag: v._tag, items: v.items.map(stripAddInfos) };
    case CborKinds.Map:
      return {
        _tag: v._tag,
        entries: v.entries.map((e) => ({
          k: stripAddInfos(e.k),
          v: stripAddInfos(e.v),
        })),
      };
    case CborKinds.Tag:
      return { _tag: v._tag, tag: v.tag, data: stripAddInfos(v.data) };
    case CborKinds.Simple:
      return { _tag: v._tag, value: v.value };
  }
};

// Build a bounded-depth CborValue arbitrary. Leaves are scalar variants;
// composites are guarded by depth budget so the average size stays small.
const makeCborArb = (): FastCheck.Arbitrary<CborValue> => {
  const leaf: FastCheck.Arbitrary<CborValue> = FastCheck.oneof(
    FastCheck.bigInt({ min: 0n, max: (1n << 63n) - 1n }).map(
      (num) => ({ _tag: CborKinds.UInt, num }) satisfies CborValue,
    ),
    FastCheck.bigInt({ min: -(1n << 63n), max: -1n }).map(
      (num) => ({ _tag: CborKinds.NegInt, num }) satisfies CborValue,
    ),
    FastCheck.uint8Array({ maxLength: 32 }).map(
      (bytes) => ({ _tag: CborKinds.Bytes, bytes }) satisfies CborValue,
    ),
    FastCheck.string({ maxLength: 24 }).map(
      (text) => ({ _tag: CborKinds.Text, text }) satisfies CborValue,
    ),
    FastCheck.boolean().map((b) => ({ _tag: CborKinds.Simple, value: b }) satisfies CborValue),
    FastCheck.constant({ _tag: CborKinds.Simple, value: null } satisfies CborValue),
    FastCheck.constant({ _tag: CborKinds.Simple, value: undefined } satisfies CborValue),
  );

  // Recursive composites — `FastCheck.letrec` ties the tree together with
  // depth-attenuated recursion (each level halves the frequency of branches).
  const { tree } = FastCheck.letrec<{ tree: CborValue }>((t) => ({
    tree: FastCheck.oneof(
      { maxDepth: 3 },
      leaf,
      FastCheck.array(t("tree"), { maxLength: 4 }).map(
        (items) => ({ _tag: CborKinds.Array, items }) satisfies CborValue,
      ),
      FastCheck.array(FastCheck.record({ k: t("tree"), v: t("tree") }), { maxLength: 3 }).map(
        (entries) => ({ _tag: CborKinds.Map, entries }) satisfies CborValue,
      ),
      FastCheck.record({
        // Exclude tags 2/3 (RFC 8949 §3.4.3 bignum): parser may normalize
        // Tag(2, bytes) → UInt and Tag(3, bytes) → NegInt, breaking the
        // structural-equality premise of P2 (value round-trip). Bignum
        // normalization is a parser feature — tested separately.
        tag: FastCheck.oneof(
          FastCheck.bigInt({ min: 0n, max: 1n }),
          FastCheck.bigInt({ min: 4n, max: 255n }),
        ),
        data: t("tree"),
      }).map(({ tag, data }) => ({ _tag: CborKinds.Tag, tag, data }) satisfies CborValue),
    ),
  }));

  return tree;
};

const cborValueArb = makeCborArb();

// ────────────────────────────────────────────────────────────────────────────
// Property P2 — value round-trip: parseSync(encodeSync(v)) structurally
// equals v (after stripping wire-format hints).
// ────────────────────────────────────────────────────────────────────────────

describe("CBOR round-trip properties", () => {
  it("P2: parseSync(encodeSync(v)) ≡ v (addInfos-insensitive)", () => {
    FastCheck.assert(
      FastCheck.property(cborValueArb, (v) => {
        const bytes = encodeSync(v);
        const parsed = parseSync(bytes);
        return Equal.equals(stripAddInfos(parsed), stripAddInfos(v));
      }),
      { numRuns: 300 },
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Property P1 — determinism: encodeSync(v) yields the same bytes on
  // repeated calls. Non-trivial because the encoder uses a resizable
  // ArrayBuffer internally; a stateful encoder bug would surface here.
  // ──────────────────────────────────────────────────────────────────────────

  it("P1: encodeSync(v) is deterministic across calls", () => {
    FastCheck.assert(
      FastCheck.property(cborValueArb, (v) => Equal.equals(encodeSync(v), encodeSync(v))),
      { numRuns: 200 },
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Property P3 — idempotence on the wire: bytes → parse → encode yields the
  // same bytes. This is the `identity.test.ts` suite generalized: every
  // valid CBOR byte stream is a fixed point of parse∘encode when addInfos
  // is preserved.
  //
  // Strategy: generate random CborValues, encode them, then re-encode the
  // parsed result. Skip inputs that trigger encoder-inserted normalization.
  // ──────────────────────────────────────────────────────────────────────────

  it("P3: parse → encode preserves byte stream (addInfos-preserving)", () => {
    FastCheck.assert(
      FastCheck.property(cborValueArb, (v) => {
        const first = encodeSync(v);
        const parsed = parseSync(first);
        const second = encodeSync(parsed);
        return Equal.equals(first, second);
      }),
      { numRuns: 200 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Primitive boundary properties — exercise the integer-width switches
// (inline ≤23, 1-byte ≤255, 2-byte ≤65535, 4-byte ≤2³²−1, 8-byte ≤2⁶⁴−1).
// ────────────────────────────────────────────────────────────────────────────

describe("CBOR integer boundary properties", () => {
  it("UInt round-trips across every width", () => {
    const widths: ReadonlyArray<FastCheck.Arbitrary<bigint>> = [
      FastCheck.bigInt({ min: 0n, max: 23n }), // inline
      FastCheck.bigInt({ min: 24n, max: 255n }), // 1-byte
      FastCheck.bigInt({ min: 256n, max: 65535n }), // 2-byte
      FastCheck.bigInt({ min: 65536n, max: (1n << 32n) - 1n }), // 4-byte
      FastCheck.bigInt({ min: 1n << 32n, max: (1n << 63n) - 1n }), // 8-byte
    ];
    for (const arb of widths) {
      FastCheck.assert(
        FastCheck.property(arb, (num) => {
          const v: CborValue = { _tag: CborKinds.UInt, num };
          const back = parseSync(encodeSync(v));
          return back._tag === CborKinds.UInt && back.num === num;
        }),
        { numRuns: 100 },
      );
    }
  });

  it("NegInt round-trips across every width", () => {
    const widths: ReadonlyArray<FastCheck.Arbitrary<bigint>> = [
      FastCheck.bigInt({ min: -24n, max: -1n }),
      FastCheck.bigInt({ min: -256n, max: -25n }),
      FastCheck.bigInt({ min: -65536n, max: -257n }),
      FastCheck.bigInt({ min: -(1n << 32n), max: -65537n }),
      FastCheck.bigInt({ min: -(1n << 63n), max: -((1n << 32n) + 1n) }),
    ];
    for (const arb of widths) {
      FastCheck.assert(
        FastCheck.property(arb, (num) => {
          const v: CborValue = { _tag: CborKinds.NegInt, num };
          const back = parseSync(encodeSync(v));
          return back._tag === CborKinds.NegInt && back.num === num;
        }),
        { numRuns: 100 },
      );
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// String / bytes boundary properties — length-prefix widths mirror integer
// widths, so the same 5 bands apply. Skip the 4-byte+ bands since random
// 65 KiB strings are overkill for a unit-test suite.
// ────────────────────────────────────────────────────────────────────────────

describe("CBOR length-prefix boundary properties", () => {
  it("Bytes round-trip across inline/1-byte/2-byte prefix widths", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.oneof(
          FastCheck.uint8Array({ maxLength: 23 }), // inline
          FastCheck.uint8Array({ minLength: 24, maxLength: 255 }), // 1-byte
          FastCheck.uint8Array({ minLength: 256, maxLength: 300 }), // 2-byte
        ),
        (bytes) => {
          const v: CborValue = { _tag: CborKinds.Bytes, bytes };
          const back = parseSync(encodeSync(v));
          return back._tag === CborKinds.Bytes && Equal.equals(back.bytes, bytes);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Text round-trip across all prefix widths (UTF-8 sensitive)", () => {
    FastCheck.assert(
      FastCheck.property(FastCheck.string({ maxLength: 300 }), (text) => {
        const v: CborValue = { _tag: CborKinds.Text, text };
        const back = parseSync(encodeSync(v));
        return back._tag === CborKinds.Text && back.text === text;
      }),
      { numRuns: 200 },
    );
  });
});
