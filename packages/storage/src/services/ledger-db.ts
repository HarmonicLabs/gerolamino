/**
 * LedgerDB — ledger state management with snapshot persistence.
 */
import { Effect, Layer, ServiceMap } from "effect";
import type { LedgerStateSnapshot } from "../types/LedgerState.ts";
import { LedgerDBError } from "../errors.ts";
import { BlobStore } from "../blob-store/service.ts";
import { SqliteDrizzle } from "../db/client.ts";
import { writeSnapshot, readLatestSnapshot } from "../operations/snapshots.ts";

export class LedgerDB extends ServiceMap.Service<
  LedgerDB,
  {
    readonly writeSnapshot: (snapshot: LedgerStateSnapshot) => Effect.Effect<void, LedgerDBError>;
    readonly readLatestSnapshot: Effect.Effect<LedgerStateSnapshot | undefined, LedgerDBError>;
  }
>()("storage/LedgerDB") {}

export const LedgerDBLive: Layer.Layer<LedgerDB, never, BlobStore | SqliteDrizzle> =
  Layer.effect(
    LedgerDB,
    Effect.gen(function* () {
      const store = yield* BlobStore;
      const drizzle = yield* SqliteDrizzle;
      const provide = <A, E>(effect: Effect.Effect<A, E, BlobStore | SqliteDrizzle>) =>
        effect.pipe(
          Effect.provideService(BlobStore, store),
          Effect.provideService(SqliteDrizzle, drizzle),
        );
      return {
        writeSnapshot: (snapshot: LedgerStateSnapshot) => provide(writeSnapshot(snapshot)),
        readLatestSnapshot: provide(readLatestSnapshot),
      };
    }),
  );
