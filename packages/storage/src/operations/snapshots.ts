/**
 * Ledger state snapshot operations — using Drizzle ORM query builder.
 */
import { Effect } from "effect";
import { desc } from "drizzle-orm";
import { SqliteDrizzle, query, schema } from "../db/client.ts";
import type { LedgerStateSnapshot } from "../types/LedgerState.ts";
import { LedgerDBError } from "../errors.ts";

export const writeSnapshot = (snapshot: LedgerStateSnapshot) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;
    yield* query(
      db
        .insert(schema.ledgerSnapshots)
        .values({
          slot: Number(snapshot.slot),
          hash: snapshot.point.hash,
          epoch: Number(snapshot.epoch),
          stateBytes: snapshot.stateBytes,
        })
        .onConflictDoUpdate({
          target: schema.ledgerSnapshots.slot,
          set: { stateBytes: snapshot.stateBytes },
        }),
    );
  }).pipe(Effect.mapError((cause) => new LedgerDBError({ operation: "writeSnapshot", cause })));

export const readLatestSnapshot = Effect.gen(function* () {
  const db = yield* SqliteDrizzle;
  const rows = yield* query(
    db.select().from(schema.ledgerSnapshots).orderBy(desc(schema.ledgerSnapshots.slot)).limit(1),
  );
  if (rows.length === 0) return undefined;
  const r = rows[0]!;
  return {
    point: { slot: BigInt(r.slot), hash: r.hash },
    stateBytes: r.stateBytes,
    epoch: BigInt(r.epoch),
    slot: BigInt(r.slot),
  } satisfies LedgerStateSnapshot;
}).pipe(Effect.mapError((cause) => new LedgerDBError({ operation: "readLatestSnapshot", cause })));
