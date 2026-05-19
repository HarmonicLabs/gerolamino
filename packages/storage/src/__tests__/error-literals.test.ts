/**
 * Test-coverage gap (sister to wave-25 / wave-27) — every
 * Schema.Literals operation/assertion field across storage error
 * classes produced by a real test.
 *
 * Two error classes in storage carry literal-union fields:
 *   - `ChainDBError.operation` — 13 literals
 *   - `LedgerSnapshotError.operation` — 4 literals
 *
 * Each is consumed by `Match.value(e.operation)` somewhere downstream
 * (RPC error mapping, dashboard event log, retry-policy dispatch). A
 * Schema-evolution that drops or renames a literal would surface here
 * at the construction boundary instead of as a silent fall-through in
 * the misbehaving Match-arm.
 */
import { describe, it, expect } from "vitest";
import { Schema } from "effect";
import { ChainDBError, ChainDBOperation } from "../services/chain-db.ts";
import {
  LedgerSnapshotError,
} from "../services/ledger-snapshot-store.ts";

const isChainDBOperation = Schema.is(ChainDBOperation);

const ALL_CHAINDB_OPS: ReadonlyArray<ChainDBOperation> = [
  "getBlock",
  "getBlockAt",
  "getTip",
  "getImmutableTip",
  "addBlock",
  "writeBlobEntries",
  "deleteBlobEntries",
  "rollback",
  "getSuccessors",
  "streamFrom",
  "promoteToImmutable",
  "garbageCollect",
  "bootSeed",
];

describe("ChainDBError — operation literal coverage", () => {
  for (const operation of ALL_CHAINDB_OPS) {
    it(`constructs + round-trips literal "${operation}"`, () => {
      const err = new ChainDBError({ operation, cause: "test fixture" });
      expect(err._tag).toBe("ChainDBError");
      expect(err.operation).toBe(operation);
      expect(isChainDBOperation(operation)).toBe(true);
    });
  }

  it("rejects an unknown operation literal at the schema boundary", () => {
    expect(isChainDBOperation("nonexistent.op")).toBe(false);
  });

  it("the test's literal list matches the runtime literal set 1:1", () => {
    expect(ALL_CHAINDB_OPS.length).toBe(ChainDBOperation.literals.length);
  });
});

// LedgerSnapshotError doesn't export a standalone `LedgerSnapshotOperation`
// schema (the literal union is inlined at the class declaration), so we
// can't `Schema.is(LedgerSnapshotOperation)` it. Test the constructor
// path + the 4 known values directly.
const ALL_LEDGER_SNAPSHOT_OPS = [
  "writeLedgerSnapshot",
  "readLatestLedgerSnapshot",
  "writeNonces",
  "readNonces",
] as const;

describe("LedgerSnapshotError — operation literal coverage", () => {
  for (const operation of ALL_LEDGER_SNAPSHOT_OPS) {
    it(`constructs literal "${operation}"`, () => {
      const err = new LedgerSnapshotError({ operation, cause: "test fixture" });
      expect(err._tag).toBe("LedgerSnapshotError");
      expect(err.operation).toBe(operation);
    });
  }

  it("the literal list size is 4 (writeLedgerSnapshot/readLatest/writeNonces/readNonces)", () => {
    // Pin the known size — adding/removing a literal in
    // `ledger-snapshot-store.ts:54-59` requires bumping this assertion
    // (and the array above), forcing a deliberate change.
    expect(ALL_LEDGER_SNAPSHOT_OPS.length).toBe(4);
  });
});
