/**
 * Test-coverage gap #26 — every `HeaderBridgeError.operation` literal
 * produced by a real test.
 *
 * `HeaderBridgeOperation` is a `Schema.Literals([…])` of 13 narrow
 * strings; each is consumed by `Match.value(e.operation)` somewhere
 * downstream (validate-header diagnostics, RPC error mapping). A
 * Schema-evolution that breaks one literal would surface here at
 * the construction boundary instead of in production at the
 * misbehaving Match-arm.
 *
 * The test deliberately constructs via the `Schema.TaggedErrorClass`
 * constructor (not the Schema decoder) so it exercises the same path
 * production code uses (`new HeaderBridgeError({…})`), and asserts
 * round-trip via `Schema.is(HeaderBridgeOperation)` to catch any
 * literal that a future refactor accidentally drops from the union.
 */
import { describe, it, expect } from "vitest";
import { Schema } from "effect";
import {
  HeaderBridgeError,
  HeaderBridgeOperation,
} from "../bridges/header.ts";

const isOperation = Schema.is(HeaderBridgeOperation);

const ALL_OPERATIONS: ReadonlyArray<HeaderBridgeOperation> = [
  "extractFirstArrayItemBytes",
  "bridgeHeader.leaderVrfTag",
  "bridgeHeader.nonceVrfTag",
  "bridgeMultiEraHeader",
  "bridgeMultiEraHeader.leaderVrfTag",
  "bridgeMultiEraHeader.nonceVrfTag",
  "decodeAndBridge",
  "decodeWrappedHeader",
  "decodeWrappedHeader.headerHash",
  "decodeByronHeader",
  "decodeByronWrappedHeader.hash",
  "computeHeaderHash",
  "computeHeaderHashFromHeader",
];

describe("HeaderBridgeError — operation literal coverage", () => {
  for (const operation of ALL_OPERATIONS) {
    it(`constructs + round-trips literal "${operation}"`, () => {
      const err = new HeaderBridgeError({ operation, cause: "test fixture" });
      expect(err._tag).toBe("HeaderBridgeError");
      expect(err.operation).toBe(operation);
      // Schema.is doubles as a "is this still in the literal union?" check —
      // a future drop or rename would fail here.
      expect(isOperation(operation)).toBe(true);
    });
  }

  it("rejects an unknown operation literal at the schema boundary", () => {
    expect(isOperation("nonexistent.op")).toBe(false);
  });

  it("the test's literal list matches the runtime literal set 1:1", () => {
    // Defends against the test going stale if the source adds a
    // 14th literal — `Schema.is` on every member of the test list
    // catches *removed* literals, but not *added* ones. Compare set
    // sizes here so a new entry in `bridges/header.ts` requires a
    // matching addition in this test file.
    expect(ALL_OPERATIONS.length).toBe(HeaderBridgeOperation.literals.length);
  });
});
