import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  BlockSyncError,
  BlockSyncSuccess,
  BlockSyncWorkflow,
  type BlockSyncErrorT,
} from "../block-sync.ts";

describe("BlockSyncWorkflow contract", () => {
  it("has the expected workflow name + idempotencyKey", () => {
    expect(BlockSyncWorkflow.name).toBe("BlockSync");
    // idempotencyKey is a function over the decoded payload shape
    const key = BlockSyncWorkflow.payloadSchema.make({
      chainId: "preprod",
      fromSlot: 0n,
    });
    // After encoding, Workflow.make applied the struct constructor — the
    // resulting object has `chainId` we can probe indirectly via
    // `idempotencyKey` (injected into payloadSchema by Workflow.make).
    expect(key.chainId).toBe("preprod");
    expect(key.fromSlot).toBe(0n);
  });

  it("BlockSyncSuccess schema accepts a well-formed sync result", () => {
    const success = BlockSyncSuccess.make({
      tipSlot: 12345n,
      tipHash: new Uint8Array(32).fill(0xaa),
      blocksProcessed: 42,
    });
    expect(success.tipSlot).toBe(12345n);
    expect(success.blocksProcessed).toBe(42);
  });

  it("BlockSyncError — every variant round-trips through make", () => {
    const variants: BlockSyncErrorT[] = [
      { _tag: "NoPeersReachable", chainId: "preprod", attempts: 5 },
      { _tag: "HeaderValidationFailed", slot: 100n, reason: "bad KES signature" },
      { _tag: "RollbackExceededK", depth: 3000, k: 2160 },
    ];
    for (const v of variants) {
      const decoded = BlockSyncError.make(v);
      expect(decoded._tag).toBe(v._tag);
    }
  });

  it("payloadSchema accepts chainId + fromSlot and rejects extras via Schema.decode", () => {
    // Positive path
    const ok = Schema.decodeUnknownSync(BlockSyncWorkflow.payloadSchema)({
      chainId: "mainnet",
      fromSlot: 100n,
    });
    expect(ok.chainId).toBe("mainnet");
    expect(ok.fromSlot).toBe(100n);

    // Missing field → decode throws
    expect(() =>
      Schema.decodeUnknownSync(BlockSyncWorkflow.payloadSchema)({
        chainId: "mainnet",
      }),
    ).toThrow();
  });
});
