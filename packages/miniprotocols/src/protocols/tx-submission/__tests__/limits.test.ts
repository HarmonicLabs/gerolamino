/**
 * TxSubmission2 ack-window invariant tests.
 *
 * Spec §3.9.2 + Haskell `txSubmissionMaxUnacked = 10`: at any time, the
 * sender must not have more than 10 tx-ids unacknowledged on the peer.
 * `isValidRequestWindow(unacked, ack, req)` enforces this at the decision
 * point — a peer sending `RequestTxIds { ack, req }` where the resulting
 * window would exceed the cap is a protocol violation we refuse to honor.
 */
import { describe, expect, it } from "@effect/vitest";
import * as FastCheck from "effect/testing/FastCheck";
import { MAX_UNACKED_TX_IDS, isValidRequestWindow } from "../limits";

describe("TxSubmission2 ack-window (spec §3.9.2)", () => {
  it("MAX_UNACKED_TX_IDS matches Haskell invariant", () => {
    expect(MAX_UNACKED_TX_IDS).toBe(10);
  });

  it("accepts empty window (0, 0, 0)", () => {
    expect(isValidRequestWindow(0, 0, 0)).toBe(true);
  });

  it("accepts exact-fill: 0 unacked + req=10 → 10 outstanding", () => {
    expect(isValidRequestWindow(0, 0, 10)).toBe(true);
  });

  it("rejects overfill: 0 unacked + req=11 → 11 would exceed cap", () => {
    expect(isValidRequestWindow(0, 0, 11)).toBe(false);
  });

  it("accepts acking-then-refilling: 10 unacked + ack=5 + req=5 → 10", () => {
    expect(isValidRequestWindow(10, 5, 5)).toBe(true);
  });

  it("rejects request when ack insufficient: 10 unacked + ack=0 + req=1", () => {
    expect(isValidRequestWindow(10, 0, 1)).toBe(false);
  });

  it("property: window never exceeds MAX_UNACKED_TX_IDS for valid inputs", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.integer({ min: 0, max: MAX_UNACKED_TX_IDS }),
        FastCheck.integer({ min: 0, max: MAX_UNACKED_TX_IDS }),
        FastCheck.integer({ min: 0, max: MAX_UNACKED_TX_IDS }),
        (unacked, ack, req) => {
          // ack can't exceed unacked — otherwise semantically invalid.
          const ackCapped = Math.min(ack, unacked);
          const valid = isValidRequestWindow(unacked, ackCapped, req);
          const resulting = unacked - ackCapped + req;
          return valid === resulting <= MAX_UNACKED_TX_IDS;
        },
      ),
      { numRuns: 500 },
    );
  });
});
