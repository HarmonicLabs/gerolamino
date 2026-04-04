/**
 * XState event types shared across storage machines.
 */
import type { StoredBlock, RealPoint } from "../types/StoredBlock.ts";
import type { LedgerStateSnapshot } from "../types/LedgerState.ts";
import type { MempoolTx } from "../types/Mempool.ts";

// ChainDB events
export type ChainDBEvent =
  | { readonly type: "BLOCK_RECEIVED"; readonly block: StoredBlock }
  | { readonly type: "CHAIN_SELECTED"; readonly tip: RealPoint }
  | { readonly type: "IMMUTABILITY_CHECK" }
  | { readonly type: "COPY_COMPLETE" }
  | { readonly type: "GC_COMPLETE" }
  | { readonly type: "SNAPSHOT_WRITTEN" }
  | { readonly type: "ROLLBACK"; readonly point: RealPoint }
  | { readonly type: "ERROR"; readonly error: unknown };

// Mempool events
export type MempoolEvent =
  | { readonly type: "TX_SUBMITTED"; readonly tx: MempoolTx }
  | { readonly type: "BLOCK_APPLIED"; readonly txIds: ReadonlyArray<Uint8Array> }
  | { readonly type: "REVALIDATE"; readonly ledgerState: LedgerStateSnapshot };
