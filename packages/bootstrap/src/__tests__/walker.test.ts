import { describe, it, expect } from "vitest";
import {
  IMMUTABLE_DIR,
  snapshotUploadPriority,
  sortSnapshotFilesForUpload,
  type SnapshotFile,
} from "../walker.ts";

const file = (opfsPath: string, size = 1): SnapshotFile => ({
  opfsPath,
  file: { size } as File,
});

describe("snapshotUploadPriority", () => {
  it("orders protocolMagicId before ledger, lsm, and other paths", () => {
    expect(snapshotUploadPriority("protocolMagicId")).toBeLessThan(
      snapshotUploadPriority("ledger/1/state"),
    );
    expect(snapshotUploadPriority("ledger/1/state")).toBeLessThan(
      snapshotUploadPriority("lsm/metadata"),
    );
    expect(snapshotUploadPriority("lsm/metadata")).toBeLessThan(
      snapshotUploadPriority("volatile/blocks"),
    );
    expect(snapshotUploadPriority("volatile/blocks")).toBeLessThan(
      snapshotUploadPriority(`${IMMUTABLE_DIR}/00000.chunk`),
    );
  });
});

describe("sortSnapshotFilesForUpload", () => {
  it("sorts by tier then lexicographic path", () => {
    const sorted = sortSnapshotFilesForUpload([
      file("lsm/b"),
      file("protocolMagicId"),
      file("ledger/2/state"),
      file("ledger/1/state"),
    ]);
    expect(sorted.map((entry) => entry.opfsPath)).toEqual([
      "protocolMagicId",
      "ledger/1/state",
      "ledger/2/state",
      "lsm/b",
    ]);
  });
});
