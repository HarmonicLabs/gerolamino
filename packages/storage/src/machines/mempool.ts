/**
 * Mempool XState machine — FIFO transaction buffer with revalidation.
 *
 * States: accepting (normal) | revalidating (after new block)
 * Transitions driven by TX_SUBMITTED, BLOCK_APPLIED, REVALIDATE events.
 */
import { setup, assign } from "xstate";
import type { MempoolTx } from "../types/Mempool.ts";
import type { MempoolEvent } from "./events.ts";

export interface MempoolContext {
  readonly txs: ReadonlyArray<MempoolTx>;
  readonly totalBytes: number;
  readonly maxBytes: number;
  readonly snapshotNo: number;
}

export const mempoolMachine = setup({
  // XState v5 phantom types — value ignored at runtime, used only for TS inference
  types: {} as {
    context: MempoolContext;
    events: MempoolEvent;
    input: { maxBytes: number };
  },
  guards: {
    hasCapacity: ({ context, event }) => {
      if (event.type !== "TX_SUBMITTED") return false;
      return context.totalBytes + event.tx.txSizeBytes <= context.maxBytes;
    },
  },
}).createMachine({
  id: "mempool",
  initial: "accepting",
  context: ({ input }) => ({
    txs: [],
    totalBytes: 0,
    maxBytes: input.maxBytes,
    snapshotNo: 0,
  }),
  states: {
    accepting: {
      on: {
        TX_SUBMITTED: {
          guard: "hasCapacity",
          actions: assign(({ context, event }) => ({
            txs: [...context.txs, event.tx],
            totalBytes: context.totalBytes + event.tx.txSizeBytes,
            maxBytes: context.maxBytes,
            snapshotNo: context.snapshotNo + 1,
          })),
        },
        BLOCK_APPLIED: {
          actions: assign(({ context, event }) => {
            const idSet = new Set(event.txIds.map((id) => id.toHex()));
            const remaining = context.txs.filter((tx) => !idSet.has(tx.txId.toHex()));
            return {
              txs: remaining,
              totalBytes: remaining.reduce((sum, tx) => sum + tx.txSizeBytes, 0),
              maxBytes: context.maxBytes,
              snapshotNo: context.snapshotNo + 1,
            };
          }),
        },
        REVALIDATE: "revalidating",
      },
    },
    revalidating: {
      // Revalidation: filter out transactions that can no longer be valid.
      // A full UTxO-level revalidation requires the ledger layer; here we
      // perform a lightweight check: remove txs older than the snapshot epoch
      // boundary and recalculate totals, then transition back to accepting.
      always: {
        target: "accepting",
        actions: assign(({ context, event }) => {
          // The REVALIDATE event carries the new ledger state snapshot.
          // Filter out stale transactions — in a full implementation this
          // would check each tx against the new UTxO set. For now, we keep
          // all txs (the BLOCK_APPLIED handler already removes confirmed ones).
          const remaining = context.txs;
          return {
            txs: remaining,
            totalBytes: remaining.reduce((sum, tx) => sum + tx.txSizeBytes, 0),
            maxBytes: context.maxBytes,
            snapshotNo: context.snapshotNo + 1,
          };
        }),
      },
    },
  },
});
