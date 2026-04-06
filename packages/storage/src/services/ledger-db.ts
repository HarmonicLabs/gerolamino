/**
 * LedgerDB — ledger state management with volatile diffs.
 *
 * Follows Amaru's volatile diff approach:
 *   - Anchor at immutable tip: full UTxO set in BlobStore (utxo prefix)
 *   - k+1 diffs in memory (structural sharing)
 *   - applyBlock → push diff
 *   - rollback → truncate + rebuild
 *   - Periodic snapshots via BlobStore
 */
import { Effect, ServiceMap } from "effect";
import type { LedgerStateSnapshot } from "../types/LedgerState.ts";
import type { RealPoint } from "../types/StoredBlock.ts";
import { LedgerDBError } from "../errors.ts";
import { writeSnapshot, readLatestSnapshot } from "../operations/snapshots.ts";

export interface LedgerDBShape {
  /** Write a ledger state snapshot (metadata to SQL, bytes to BlobStore). */
  readonly writeSnapshot: (
    snapshot: LedgerStateSnapshot,
  ) => Effect.Effect<void, LedgerDBError>;

  /** Read the latest snapshot. */
  readonly readLatestSnapshot: Effect.Effect<
    LedgerStateSnapshot | undefined,
    LedgerDBError
  >;

  // TODO Phase 2E: volatile diffs
  // readonly applyBlock: (block: StoredBlock) => Effect<void, LedgerDBError>
  // readonly rollback: (point: RealPoint) => Effect<void, LedgerDBError>
  // readonly forecast: (slot: bigint) => Effect<LedgerView, LedgerDBError>
}

export class LedgerDB extends ServiceMap.Service<LedgerDB, LedgerDBShape>()(
  "storage/LedgerDB",
) {}

/** Default LedgerDB implementation — requires SqliteDrizzle + BlobStore. */
export const LedgerDBLive = Effect.succeed({
  writeSnapshot: (snapshot) => writeSnapshot(snapshot),
  readLatestSnapshot,
} satisfies LedgerDBShape);
