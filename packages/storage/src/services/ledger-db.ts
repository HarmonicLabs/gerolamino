/**
 * LedgerDB — ledger state management with snapshot persistence.
 */
import { Context, Effect, Layer, Option } from "effect";
import type { LedgerStateSnapshot } from "../types/LedgerState.ts";
import { LedgerDBError } from "../errors.ts";
import { BlobStore } from "../blob-store";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { writeSnapshot, readLatestSnapshot } from "../operations/snapshots.ts";

export class LedgerDB extends Context.Service<
  LedgerDB,
  {
    readonly writeSnapshot: (snapshot: LedgerStateSnapshot) => Effect.Effect<void, LedgerDBError>;
    readonly readLatestSnapshot: Effect.Effect<Option.Option<LedgerStateSnapshot>, LedgerDBError>;
  }
>()("storage/LedgerDB") {}

export const LedgerDBLive: Layer.Layer<LedgerDB, never, BlobStore | SqlClient> = Layer.effect(
  LedgerDB,
  Effect.gen(function* () {
    const store = yield* BlobStore;
    const sql = yield* SqlClient;
    const provide = <A, E>(effect: Effect.Effect<A, E, BlobStore | SqlClient>) =>
      effect.pipe(
        Effect.provideService(BlobStore, store),
        Effect.provideService(SqlClient, sql),
      );
    return {
      writeSnapshot: (snapshot: LedgerStateSnapshot) => provide(writeSnapshot(snapshot)),
      readLatestSnapshot: provide(readLatestSnapshot),
    };
  }),
);
