/**
 * Test-coverage gap #26 (sub-item) — every `HeaderValidationError.assertion`
 * literal produced by a real test.
 *
 * Sister to `header-bridge-error.test.ts` (wave 25). `HeaderAssertion`
 * is a `Schema.Literals([…])` of 6 narrow strings; each is consumed by
 * `Match.value(e.assertion)` somewhere downstream (RPC error mapping,
 * dashboard event log, validator dispatch).
 *
 * Constructs via the `Schema.TaggedErrorClass` constructor (the same
 * path production code uses: `new HeaderValidationError({…})`) and
 * round-trips via `Schema.is(HeaderAssertion)` so a future schema
 * evolution that drops or renames a literal surfaces here at the
 * construction boundary instead of as a silent fall-through in the
 * misbehaving Match-arm.
 */
import { describe, it, expect } from "vitest";
import { Schema } from "effect";
import {
  HeaderAssertion,
  HeaderValidationError,
} from "../validate/header.ts";

const isAssertion = Schema.is(HeaderAssertion);

const ALL_ASSERTIONS: ReadonlyArray<HeaderAssertion> = [
  "Envelope",
  "AssertKnownLeaderVrf",
  "AssertVrfProof",
  "AssertLeaderStake",
  "AssertKesSignature",
  "AssertOperationalCertificate",
];

describe("HeaderValidationError — assertion literal coverage", () => {
  for (const assertion of ALL_ASSERTIONS) {
    it(`constructs + round-trips literal "${assertion}"`, () => {
      const err = new HeaderValidationError({
        assertion,
        message: "test fixture",
      });
      expect(err._tag).toBe("HeaderValidationError");
      expect(err.assertion).toBe(assertion);
      // Schema.is doubles as an "is this still in the literal union?"
      // check — a future drop or rename would fail here.
      expect(isAssertion(assertion)).toBe(true);
    });
  }

  it("rejects an unknown assertion literal at the schema boundary", () => {
    expect(isAssertion("AssertSomethingMadeUp")).toBe(false);
  });

  it("the test's literal list matches the runtime literal set 1:1", () => {
    // Defends against the test going stale if the source adds a 7th
    // literal — `Schema.is` on every member of the test list catches
    // *removed* literals, but not *added* ones. Compare set sizes here
    // so a new entry in `validate/header.ts::HeaderAssertion` requires
    // a matching addition in this test file.
    expect(ALL_ASSERTIONS.length).toBe(HeaderAssertion.literals.length);
  });

  it("preserves optional blockSlot + blockHash when provided", () => {
    // The headerValidationError helper at validate/header.ts:40 always
    // attaches blockSlot + blockHash. Verify the optional Schema fields
    // round-trip through the constructor so an evolution that demotes
    // them (or changes their codec) surfaces here.
    const err = new HeaderValidationError({
      assertion: "AssertKesSignature",
      message: "kes verify failed",
      blockSlot: 12345n,
      blockHash: new Uint8Array(32),
    });
    expect(err.blockSlot).toBe(12345n);
    expect(err.blockHash).toBeInstanceOf(Uint8Array);
    expect(err.blockHash?.length).toBe(32);
  });
});
