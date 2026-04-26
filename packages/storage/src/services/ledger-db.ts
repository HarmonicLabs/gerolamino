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
    // One pre-built `BlobStore | SqlClient` context — `Effect.provide(ctx)`
    // is a single pipe step per op instead of two `provideService` calls.
    const ctx = Context.make(BlobStore, store).pipe(Context.add(SqlClient, sql));
    const provide = Effect.provide(ctx);
    return {
      writeSnapshot: (snapshot: LedgerStateSnapshot) => provide(writeSnapshot(snapshot)),
      readLatestSnapshot: provide(readLatestSnapshot),
    };
  }),
);
