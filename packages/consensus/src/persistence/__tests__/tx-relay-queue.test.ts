/**
 * Tx-relay outbox — `PersistedQueue` round-trip test.
 *
 * Verifies:
 *   - Offer + take returns the same entry bytes + metadata fields.
 *   - FIFO: two offers taken in order return the same order.
 *   - Failure + retry: a handler that fails once increments the attempt
 *     counter; second take sees `attempts: 1`.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  TxRelayQueueTestLayer,
  makeTxRelayQueue,
  type TxRelayEntry,
} from "../tx-relay-queue";

const mkEntry = (first: number): TxRelayEntry => ({
  txId: new Uint8Array(32).fill(first),
  txCbor: new Uint8Array(64).fill(first),
  addedSlot: BigInt(first) * 100n,
  feePerByte: first / 10,
  sizeBytes: 64,
});

describe("TxRelayQueue — PersistedQueue outbox", () => {
  it.effect("offer then take returns the same entry", () =>
    Effect.gen(function* () {
      const queue = yield* makeTxRelayQueue;
      const entry = mkEntry(1);
      yield* queue.raw.offer(entry);
      const taken = yield* queue.takeEntry((e, meta) =>
        Effect.succeed({
          feePerByte: e.feePerByte,
          txIdFirst: e.txId[0],
          attempts: meta.attempts,
        }),
      );
      expect(taken.feePerByte).toBe(0.1);
      expect(taken.txIdFirst).toBe(1);
      expect(taken.attempts).toBe(0);
    }).pipe(Effect.provide(TxRelayQueueTestLayer)),
  );

  it.effect("FIFO: two offers preserve order", () =>
    Effect.gen(function* () {
      const queue = yield* makeTxRelayQueue;
      yield* queue.raw.offer(mkEntry(1));
      yield* queue.raw.offer(mkEntry(2));
      const first = yield* queue.takeEntry((e) => Effect.succeed(e.txId[0]));
      const second = yield* queue.takeEntry((e) => Effect.succeed(e.txId[0]));
      expect(first).toBe(1);
      expect(second).toBe(2);
    }).pipe(Effect.provide(TxRelayQueueTestLayer)),
  );

  it.effect("handler failure re-offers entry with incremented attempt", () =>
    Effect.gen(function* () {
      const queue = yield* makeTxRelayQueue;
      yield* queue.raw.offer(mkEntry(7));
      // First attempt — handler fails, entry is re-offered.
      yield* Effect.flip(
        queue.takeEntry(() => Effect.fail(new Error("synthetic"))),
      );
      // Second take — attempt counter reflects the prior failure.
      const secondAttempt = yield* queue.takeEntry((_e, meta) =>
        Effect.succeed(meta.attempts),
      );
      expect(secondAttempt).toBe(1);
    }).pipe(Effect.provide(TxRelayQueueTestLayer)),
  );
});
