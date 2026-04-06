/**
 * LedgerDB — ledger state management with snapshot persistence.
 */
import { Effect, Layer, ServiceMap } from "effect";
import type { LedgerStateSnapshot } from "../types/LedgerState.ts";
import { LedgerDBError } from "../errors.ts";
import { writeSnapshot, readLatestSnapshot } from "../operations/snapshots.ts";

export class LedgerDB extends ServiceMap.Service<
  LedgerDB,
  {
    readonly writeSnapshot: (snapshot: LedgerStateSnapshot) => Effect.Effect<void, LedgerDBError>;
    readonly readLatestSnapshot: Effect.Effect<LedgerStateSnapshot | undefined, LedgerDBError>;
  }
>()("storage/LedgerDB") {}

export const LedgerDBLive: Layer.Layer<LedgerDB> = Layer.succeed(LedgerDB, {
  writeSnapshot: (snapshot: LedgerStateSnapshot) => writeSnapshot(snapshot),
  readLatestSnapshot,
});
