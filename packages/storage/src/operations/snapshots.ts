/**
 * Ledger state snapshot operations — dual-layer architecture.
 *
 * Metadata (slot, hash, epoch) stays in SQL via Drizzle's query builder
 * over the abstract `SqlClient`. State bytes (large CBOR blob) move to
 * BlobStore with a deterministic key.
 */
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { desc, sql as sqlExpr } from "drizzle-orm";
import { LedgerStateSnapshot } from "../types/LedgerState.ts";
import { LedgerDBError } from "../errors.ts";
import { BlobStore, snapshotKey } from "../blob-store";
import { ledgerSnapshots } from "../schema/index.ts";
import { compile, db } from "../services/drizzle.ts";

// ---------------------------------------------------------------------------
// Row schema — kept for runtime decoding alongside Drizzle's
// `$inferSelect` typing. Runtime validation catches DB drift that the
// type system cannot.
// ---------------------------------------------------------------------------

const SnapshotRow = Schema.Struct({
  slot: Schema.Number,
  hash: Schema.Uint8Array,
  epoch: Schema.Number,
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const writeSnapshot = (snapshot: LedgerStateSnapshot) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const store = yield* BlobStore;

    yield* sql.withTransaction(
      Effect.all(
        [
          store.put(snapshotKey(snapshot.slot), snapshot.stateBytes),
          compile(
            sql,
            db
              .insert(ledgerSnapshots)
              .values({
                slot: Number(snapshot.slot),
                hash: snapshot.point.hash,
                epoch: Number(snapshot.epoch),
              })
              .onConflictDoUpdate({
                target: ledgerSnapshots.slot,
                set: { hash: sqlExpr`excluded.hash` },
              }),
          ),
        ],
        { concurrency: "unbounded" },
      ),
    );
  }).pipe(Effect.mapError((cause) => new LedgerDBError({ operation: "writeSnapshot", cause })));

export const readLatestSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const store = yield* BlobStore;
  const findLatest = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: SnapshotRow,
    execute: () =>
      compile(
        sql,
        db.select().from(ledgerSnapshots).orderBy(desc(ledgerSnapshots.slot)).limit(1),
      ),
  });
  const rowOpt = yield* findLatest(undefined);
  if (Option.isNone(rowOpt)) return Option.none<LedgerStateSnapshot>();
  const r = rowOpt.value;
  const bytesOpt = yield* store.get(snapshotKey(BigInt(r.slot)));
  return Option.map(
    bytesOpt,
    (stateBytes): LedgerStateSnapshot => ({
      point: { slot: BigInt(r.slot), hash: r.hash },
      stateBytes,
      epoch: BigInt(r.epoch),
      slot: BigInt(r.slot),
    }),
  );
}).pipe(Effect.mapError((cause) => new LedgerDBError({ operation: "readLatestSnapshot", cause })));
