/**
 * Ledger state snapshot operations — dual-layer architecture.
 *
 * Metadata (slot, hash, epoch) stays in SQL (Effect SqlClient).
 * State bytes (large CBOR blob) move to BlobStore with a deterministic key.
 */
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { LedgerStateSnapshot } from "../types/LedgerState.ts";
import { LedgerDBError } from "../errors.ts";
import { BlobStore, snapshotKey } from "../blob-store";

// ---------------------------------------------------------------------------
// Row schema
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
          sql`INSERT INTO ledger_snapshots ${sql.insert({
            slot: Number(snapshot.slot),
            hash: snapshot.point.hash,
            epoch: Number(snapshot.epoch),
          })} ON CONFLICT(slot) DO UPDATE SET hash = excluded.hash`,
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
    execute: () => sql`
      SELECT slot, hash, epoch FROM ledger_snapshots
      ORDER BY slot DESC LIMIT 1
    `,
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
