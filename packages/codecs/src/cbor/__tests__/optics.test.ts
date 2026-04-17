import { describe, expect, it } from "@effect/vitest";
import { Optic, Result, Schema } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { CborKinds, type CborValue } from "../CborValue";
import {
  CborValueOptics,
  CborValueTraversals,
  toCborIso,
} from "../derive/toIso";

// ────────────────────────────────────────────────────────────────────────────
// toCborIso — domain type ↔ CborValue
// ────────────────────────────────────────────────────────────────────────────

describe("toCborIso", () => {
  it("round-trips a primitive schema", () => {
    const iso = toCborIso(Schema.String);
    const encoded = iso.get("hello");
    expect(encoded).toStrictEqual({ _tag: CborKinds.Text, text: "hello" });
    expect(iso.set(encoded)).toBe("hello");
  });

  it("round-trips a struct schema into CBOR Map form", () => {
    const Person = Schema.Struct({ name: Schema.String, age: Schema.Number });
    const iso = toCborIso(Person);
    const value = { name: "Ada", age: 42 };

    const encoded = iso.get(value);
    expect(encoded._tag).toBe(CborKinds.Map);

    const decoded = iso.set(encoded);
    expect(decoded).toStrictEqual(value);
  });

  it("Iso law: iso.set(iso.get(s)) === s for arbitrary ints", () => {
    const iso = toCborIso(Schema.BigInt);
    FastCheck.assert(
      FastCheck.property(
        FastCheck.bigInt({ min: -(1n << 60n), max: 1n << 60n }),
        (n) => iso.set(iso.get(n)) === n,
      ),
      { numRuns: 200 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Variant prisms — 8 major-type-discriminated narrowings.
// ────────────────────────────────────────────────────────────────────────────

describe("CborValueOptics variant prisms", () => {
  const uintVal: CborValue = { _tag: CborKinds.UInt, num: 42n };
  const textVal: CborValue = { _tag: CborKinds.Text, text: "hi" };
  const arrayVal: CborValue = { _tag: CborKinds.Array, items: [uintVal, textVal] };

  it("getResult succeeds only on matching variant", () => {
    expect(Result.isSuccess(CborValueOptics.uint.getResult(uintVal))).toBe(true);
    expect(Result.isSuccess(CborValueOptics.uint.getResult(textVal))).toBe(false);
    expect(Result.isSuccess(CborValueOptics.text.getResult(textVal))).toBe(true);
    expect(Result.isSuccess(CborValueOptics.array.getResult(arrayVal))).toBe(true);
  });

  it("Prism round-trip law: getResult(replace(a, s)) === Result.succeed(a)", () => {
    const newUint = { _tag: CborKinds.UInt as const, num: 99n };
    const replaced = CborValueOptics.uint.replace(newUint, uintVal);
    const got = CborValueOptics.uint.getResult(replaced);
    expect(Result.isSuccess(got)).toBe(true);
    if (Result.isSuccess(got)) expect(got.success).toStrictEqual(newUint);
  });

  it("Prism .modify no-ops on non-matching variant (Optional behavior)", () => {
    // Plain `.replace(a, _)` on a Prism ignores `s` (Prism's `set: A => S` is
    // total). `.modify(f)` is the right API when you want "update-in-place
    // or leave alone": it calls `getResult(s)`, and on failure returns `s`.
    const bumpUint = CborValueOptics.uint.modify(
      (u): Extract<CborValue, { _tag: CborKinds.UInt }> => ({ ...u, num: u.num + 1n }),
    );
    expect(bumpUint(textVal)).toBe(textVal);
    expect(bumpUint(uintVal)).toStrictEqual({ _tag: CborKinds.UInt, num: 43n });
  });

  it(".key() composes after .tag() (Prism + Lens = Optional)", () => {
    const numLens = CborValueOptics.uint.key("num");
    const got = numLens.getResult(uintVal);
    expect(Result.isSuccess(got)).toBe(true);
    if (Result.isSuccess(got)) expect(got.success).toBe(42n);
  });

  it(".modify() on composed Optional no-ops when prism fails", () => {
    const doubled = CborValueOptics.uint.key("num").modify((n) => n * 2n);
    expect(doubled(uintVal)).toStrictEqual({ _tag: CborKinds.UInt, num: 84n });
    expect(doubled(textVal)).toBe(textVal);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Traversals — iterate and replace inside composite CBOR values.
// ────────────────────────────────────────────────────────────────────────────

describe("CborValueTraversals", () => {
  const uint = (n: bigint): CborValue => ({ _tag: CborKinds.UInt, num: n });

  it("arrayItems.modifyAll doubles every UInt's num", () => {
    const input: CborValue = {
      _tag: CborKinds.Array,
      items: [uint(1n), uint(2n), uint(3n)],
    };
    const doubledFirstUint = CborValueTraversals.arrayItems.modifyAll(
      CborValueOptics.uint.key("num").modify((n) => n * 2n),
    );
    const out = doubledFirstUint(input);
    expect(out).toStrictEqual({
      _tag: CborKinds.Array,
      items: [uint(2n), uint(4n), uint(6n)],
    });
  });

  it("arrayItems.getAll extracts every element", () => {
    const input: CborValue = {
      _tag: CborKinds.Array,
      items: [uint(1n), uint(2n), uint(3n)],
    };
    const all = Optic.getAll(CborValueTraversals.arrayItems)(input);
    expect(all).toStrictEqual([uint(1n), uint(2n), uint(3n)]);
  });

  it("mapValues.modifyAll updates every value slot, leaves keys", () => {
    const input: CborValue = {
      _tag: CborKinds.Map,
      entries: [
        { k: { _tag: CborKinds.Text, text: "a" }, v: uint(1n) },
        { k: { _tag: CborKinds.Text, text: "b" }, v: uint(2n) },
      ],
    };
    const out = CborValueTraversals.mapValues.modifyAll(
      CborValueOptics.uint.key("num").modify((n) => n + 10n),
    )(input);
    expect(out).toStrictEqual({
      _tag: CborKinds.Map,
      entries: [
        { k: { _tag: CborKinds.Text, text: "a" }, v: uint(11n) },
        { k: { _tag: CborKinds.Text, text: "b" }, v: uint(12n) },
      ],
    });
  });

  it("tagData reads the payload of a Tag variant", () => {
    const tagged: CborValue = { _tag: CborKinds.Tag, tag: 24n, data: uint(7n) };
    const got = CborValueTraversals.tagData.getResult(tagged);
    expect(Result.isSuccess(got)).toBe(true);
    if (Result.isSuccess(got)) expect(got.success).toStrictEqual(uint(7n));
  });

  it("Traversal law (identity): modifyAll(id) preserves getAll", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.array(FastCheck.bigInt({ min: 0n, max: 1000n }), { maxLength: 20 }),
        (ns) => {
          const input: CborValue = {
            _tag: CborKinds.Array,
            items: ns.map(uint),
          };
          const before = Optic.getAll(CborValueTraversals.arrayItems)(input);
          const noop = CborValueTraversals.arrayItems.modifyAll((x: CborValue) => x)(input);
          const after = Optic.getAll(CborValueTraversals.arrayItems)(noop);
          return JSON.stringify(before, bigintReplacer) ===
            JSON.stringify(after, bigintReplacer);
        },
      ),
      { numRuns: 100 },
    );
  });
});

const bigintReplacer = (_: string, v: unknown): unknown =>
  typeof v === "bigint" ? `${v}n` : v;
