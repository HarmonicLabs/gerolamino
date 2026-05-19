/**
 * Test-coverage gap (sister to wave-25 / wave-27) — every
 * Schema.Literals operation/assertion field across consensus
 * RPC + validate error classes produced by a real test.
 *
 * Two error classes in consensus carry literal-union fields:
 *   - `ValidationError.operation` — 9 literals (consensus/rpc/validation-rpc-group.ts:47-57)
 *   - `BlockValidationError.assertion` — 2 literals (consensus/validate/block.ts:26)
 *
 * Each is consumed by `Match.value(...)` for RPC error mapping +
 * block-validation dispatch. A Schema-evolution that drops or renames
 * a literal would surface here at the construction boundary instead
 * of as a silent fall-through in the misbehaving Match-arm.
 */
import { describe, it, expect } from "vitest";
import { Schema } from "effect";
import { ValidationError, ValidationOperation } from "../rpc/validation-rpc-group.ts";
import { BlockAssertion, BlockValidationError } from "../validate/block.ts";

const isValidationOperation = Schema.is(ValidationOperation);

const ALL_VALIDATION_OPS: ReadonlyArray<ValidationOperation> = [
  "ComputeBodyHash",
  "ComputeTxId",
  "DecodeBlockCbor",
  "Ed25519Verify",
  "KesSum6Verify",
  "CheckVrfLeader",
  "VrfVerify",
  "VrfProofToHash",
  "Blake2b256Tagged",
];

describe("ValidationError — operation literal coverage", () => {
  for (const operation of ALL_VALIDATION_OPS) {
    it(`constructs + round-trips literal "${operation}"`, () => {
      const err = new ValidationError({
        operation,
        message: "test fixture",
      });
      expect(err._tag).toBe("consensus/ValidationError");
      expect(err.operation).toBe(operation);
      expect(isValidationOperation(operation)).toBe(true);
    });
  }

  it("rejects an unknown operation literal at the schema boundary", () => {
    expect(isValidationOperation("nonexistent.op")).toBe(false);
  });

  it("the test's literal list matches the runtime literal set 1:1", () => {
    expect(ALL_VALIDATION_OPS.length).toBe(ValidationOperation.literals.length);
  });
});

const isBlockAssertion = Schema.is(BlockAssertion);

const ALL_BLOCK_ASSERTIONS: ReadonlyArray<BlockAssertion> = [
  "VerifyBodyHash",
  "BlockSizeLimit",
];

describe("BlockValidationError — assertion literal coverage", () => {
  for (const assertion of ALL_BLOCK_ASSERTIONS) {
    it(`constructs + round-trips literal "${assertion}"`, () => {
      const err = new BlockValidationError({
        assertion,
        cause: "test fixture",
      });
      expect(err._tag).toBe("BlockValidationError");
      expect(err.assertion).toBe(assertion);
      expect(isBlockAssertion(assertion)).toBe(true);
    });
  }

  it("rejects an unknown assertion at the schema boundary", () => {
    expect(isBlockAssertion("VerifyAnimalHash")).toBe(false);
  });

  it("the test's literal list matches the runtime literal set 1:1", () => {
    expect(ALL_BLOCK_ASSERTIONS.length).toBe(BlockAssertion.literals.length);
  });
});
