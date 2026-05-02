/**
 * LedgerSnapshotStore — durable ledger-state snapshots + Praos nonce
 * triples for the consensus layer.
 *
 * Split out of `ChainDB` so the chain-tracking responsibilities (blocks /
 * tip / rollback / GC) stay orthogonal to the ledger-state persistence
 * responsibilities (snapshot / nonces). Both share the same `BlobStore`
 * + `SqlClient` backing, but the service contracts are independent.
 *
 * The 4-method surface is used by:
 *   - `packages/consensus/src/sync/relay.ts` — resume-from-snapshot on
 *     reconnect.
 *   - `packages/consensus/src/sync/bootstrap.ts` — materialise a
 *     Mithril-delivered snapshot into local state.
 *   - `packages/consensus/src/praos/nonce.ts` + `sync/driver.ts` —
 *     persist per-epoch nonces so a restart replays from the last
 *     completed epoch boundary instead of re-deriving from genesis.
 */
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { desc, sql as sqlExpr } from "drizzle-orm";
import { BlobStore, snapshotKey } from "../blob-store";
import type { RealPoint } from "../types/StoredBlock.ts";
import { ledgerSnapshots, nonces } from "../schema/index.ts";
import { compile, db } from "./drizzle.ts";

/** Error surface — separate from `ChainDBError` so callers that only need
 * snapshot/nonce ops don't have to handle chain-DB failure modes. */
export class LedgerSnapshotError extends Schema.TaggedErrorClass<LedgerSnapshotError>()(
  "LedgerSnapshotError",
  {
    operation: Schema.Literals([
      "writeLedgerSnapshot",
      "readLatestLedgerSnapshot",
      "writeNonces",
      "readNonces",
    ]),
    cause: Schema.Defect,
  },
) {}

export class LedgerSnapshotStore extends Context.Service<
  LedgerSnapshotStore,
  {
    /** Persist a ledger state snapshot at `(slot, hash, epoch)`. Upserts on
     * `slot` conflict so repeated writes at the same slot refresh the hash. */
    readonly writeLedgerSnapshot: (
      slot: bigint,
      hash: Uint8Array,
      epoch: bigint,
      stateBytes: Uint8Array,
    ) => Effect.Effect<void, LedgerSnapshotError>;

    /** Read the most-recent persisted snapshot. */
    readonly readLatestLedgerSnapshot: Effect.Effect<
      Option.Option<{ point: RealPoint; stateBytes: Uint8Array; epoch: bigint }>,
      LedgerSnapshotError
    >;

    /** Persist nonces for a given epoch. Upserts on `epoch` conflict. */
    readonly writeNonces: (
      epoch: bigint,
      active: Uint8Array,
      evolving: Uint8Array,
      candidate: Uint8Array,
    ) => Effect.Effect<void, LedgerSnapshotError>;

    /** Read the most-recent persisted nonces. */
    readonly readNonces: Effect.Effect<
      Option.Option<{
        epoch: bigint;
        active: Uint8Array;
        evolving: Uint8Array;
        candidate: Uint8Array;
      }>,
      LedgerSnapshotError
    >;
  }
>()("storage/LedgerSnapshotStore") {}

// ---------------------------------------------------------------------------
// SQL row schemas — typed decode of ledger-snapshot + nonce rows.
// ---------------------------------------------------------------------------

const SnapshotRow = Schema.Struct({
  slot: Schema.Number,
  hash: Schema.Uint8Array,
  epoch: Schema.Number,
});

const NoncesRow = Schema.Struct({
  epoch: Schema.Number,
  active: Schema.Uint8Array,
  evolving: Schema.Uint8Array,
  candidate: Schema.Uint8Array,
});

type SnapshotOp = "writeLedgerSnapshot" | "readLatestLedgerSnapshot" | "writeNonces" | "readNonces";

const withOp =
  (operation: SnapshotOp) =>
  <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, LedgerSnapshotError, R> =>
    Effect.mapError(effect, (cause) => new LedgerSnapshotError({ operation, cause }));

export const LedgerSnapshotStoreLive: Layer.Layer<
  LedgerSnapshotStore,
  never,
  BlobStore | SqlClient
> = Layer.effect(
  LedgerSnapshotStore,
  Effect.gen(function* () {
    const store = yield* BlobStore;
    const sql = yield* SqlClient;

    const findLatestSnapshot = SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: SnapshotRow,
      execute: () =>
        compile(
          sql,
          db.select().from(ledgerSnapshots).orderBy(desc(ledgerSnapshots.slot)).limit(1),
        ),
    });

    const findLatestNonces = SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: NoncesRow,
      execute: () => compile(sql, db.select().from(nonces).orderBy(desc(nonces.epoch)).limit(1)),
    });

    return {
      writeLedgerSnapshot: (slot, hash, epoch, stateBytes) =>
        sql
          .withTransaction(
            Effect.all(
              [
                store.put(snapshotKey(slot), stateBytes),
                compile(
                  sql,
                  db
                    .insert(ledgerSnapshots)
                    .values({ slot: Number(slot), hash, epoch: Number(epoch) })
                    .onConflictDoUpdate({
                      target: ledgerSnapshots.slot,
                      set: { hash: sqlExpr`excluded.hash` },
                    }),
                ),
              ],
              { concurrency: "unbounded" },
            ),
          )
          .pipe(withOp("writeLedgerSnapshot")),

      readLatestLedgerSnapshot: Effect.gen(function* () {
        const rowOpt = yield* findLatestSnapshot(undefined);
        if (Option.isNone(rowOpt)) {
          return Option.none<{
            point: RealPoint;
            stateBytes: Uint8Array;
            epoch: bigint;
          }>();
        }
        const r = rowOpt.value;
        const bytesOpt = yield* store.get(snapshotKey(BigInt(r.slot)));
        return Option.map(bytesOpt, (stateBytes) => ({
          point: { slot: BigInt(r.slot), hash: r.hash },
          stateBytes,
          epoch: BigInt(r.epoch),
        }));
      }).pipe(withOp("readLatestLedgerSnapshot")),

      writeNonces: (epoch, active, evolving, candidate) =>
        compile(
          sql,
          db
            .insert(nonces)
            .values({ epoch: Number(epoch), active, evolving, candidate })
            .onConflictDoUpdate({
              target: nonces.epoch,
              set: {
                active: sqlExpr`excluded.active`,
                evolving: sqlExpr`excluded.evolving`,
                candidate: sqlExpr`excluded.candidate`,
              },
            }),
        ).pipe(withOp("writeNonces")),

      readNonces: findLatestNonces(undefined).pipe(
        Effect.map(
          Option.map((r) => ({
            epoch: BigInt(r.epoch),
            active: r.active,
            evolving: r.evolving,
            candidate: r.candidate,
          })),
        ),
        withOp("readNonces"),
      ),
    };
  }),
);
