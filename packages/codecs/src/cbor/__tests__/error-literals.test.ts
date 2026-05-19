/**
 * Test-coverage gap (sister to wave-25 / wave-27) — every
 * Schema.Literals operation/link field across codecs error classes
 * produced by a real test.
 *
 * Three error classes in codecs carry literal-union fields:
 *   - `CborDecodeError.operation` — 3 literals (cbor/CborError.ts:30)
 *   - `CborDerivationError.link` — 7 literals (cbor/CborError.ts:65-73)
 *   - `MemPackDerivationError.link` — 5 literals (mempack/MemPackError.ts:20-26)
 *
 * Each is consumed by `Match.value(...)` for diagnostic dispatch in
 * the codec walker. A Schema-evolution that drops or renames a literal
 * would surface here at the construction boundary instead of as a silent
 * fall-through in the misbehaving Match-arm.
 */
import { describe, it, expect } from "vitest";
import { Schema } from "effect";
import {
  CborDecodeError,
  CborDecodeOperation,
  CborDerivationError,
  CborDerivationLink,
} from "../CborError.ts";
import {
  MemPackDerivationError,
  MemPackDerivationLink,
} from "../../mempack/MemPackError.ts";

const isCborDecodeOp = Schema.is(CborDecodeOperation);

const ALL_CBOR_DECODE_OPS: ReadonlyArray<CborDecodeOperation> = [
  "parse",
  "skip",
  "narrow",
];

describe("CborDecodeError — operation literal coverage", () => {
  for (const operation of ALL_CBOR_DECODE_OPS) {
    it(`constructs literal "${operation}"`, () => {
      // CborDecodeError takes a `reason: CborDecodeReason` (a tagged
      // union) — pass a minimal `MalformedHeader` reason so the test
      // exercises the construction path without depending on a real
      // CBOR fixture.
      const err = new CborDecodeError({
        operation,
        reason: { _tag: "MalformedHeader", at: 0, addInfos: 0, message: "test" },
      });
      expect(err._tag).toBe("CborDecodeError");
      expect(err.operation).toBe(operation);
      expect(isCborDecodeOp(operation)).toBe(true);
    });
  }

  it("rejects an unknown operation", () => {
    expect(isCborDecodeOp("nonexistent")).toBe(false);
  });

  it("the test's literal list matches the runtime literal set 1:1", () => {
    expect(ALL_CBOR_DECODE_OPS.length).toBe(CborDecodeOperation.literals.length);
  });
});

const isCborDerivationLink = Schema.is(CborDerivationLink);

const ALL_CBOR_DERIVATION_LINKS: ReadonlyArray<CborDerivationLink> = [
  "taggedUnionLink",
  "sparseMapLink",
  "cborTaggedLink",
  "cborInCborLink",
  "positionalArrayLink",
  "objectsWalker",
  "literalEncoder",
];

describe("CborDerivationError — link literal coverage", () => {
  for (const link of ALL_CBOR_DERIVATION_LINKS) {
    it(`constructs + round-trips literal "${link}"`, () => {
      const err = new CborDerivationError({
        link,
        message: "test fixture",
      });
      expect(err._tag).toBe("CborDerivationError");
      expect(err.link).toBe(link);
      expect(isCborDerivationLink(link)).toBe(true);
    });
  }

  it("rejects an unknown link", () => {
    expect(isCborDerivationLink("invalidLink")).toBe(false);
  });

  it("the test's literal list matches the runtime literal set 1:1", () => {
    expect(ALL_CBOR_DERIVATION_LINKS.length).toBe(CborDerivationLink.literals.length);
  });
});

const isMemPackLink = Schema.is(MemPackDerivationLink);

const ALL_MEMPACK_LINKS: ReadonlyArray<MemPackDerivationLink> = [
  "walkBase",
  "enumCodec",
  "arraysCodec",
  "unionCodec",
  "taggedUnionCodec",
];

describe("MemPackDerivationError — link literal coverage", () => {
  for (const link of ALL_MEMPACK_LINKS) {
    it(`constructs + round-trips literal "${link}"`, () => {
      const err = new MemPackDerivationError({
        link,
        message: "test fixture",
      });
      expect(err._tag).toBe("MemPackDerivationError");
      expect(err.link).toBe(link);
      expect(isMemPackLink(link)).toBe(true);
    });
  }

  it("rejects an unknown link", () => {
    expect(isMemPackLink("invalidLink")).toBe(false);
  });

  it("the test's literal list matches the runtime literal set 1:1", () => {
    expect(ALL_MEMPACK_LINKS.length).toBe(MemPackDerivationLink.literals.length);
  });
});
