/**
 * Ledger state snapshot operations — dual-layer architecture.
 *
 * Metadata (slot, hash, epoch) stays in SQL (Drizzle ORM).
 * State bytes (large CBOR blob) move to BlobStore with a deterministic key.
 */
import { Effect, Option } from "effect";
import { desc, eq } from "drizzle-orm";
import { SqliteDrizzle, query, schema } from "../db";
import { LedgerStateSnapshot } from "../types/LedgerState.ts";
import { LedgerDBError } from "../errors.ts";
import { BlobStore } from "../blob-store";

/** Convert Uint8Array to Buffer for Drizzle blob columns. */
const buf = (data: Uint8Array): Buffer =>
  Buffer.from(data.buffer, data.byteOffset, data.byteLength);

/** Convert Buffer from Drizzle back to plain Uint8Array for domain types. */
const u8 = (b: Buffer): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

/** BlobStore key for a ledger snapshot: "snap" + slot (8B BE). */
const snapshotBlobKey = (slot: bigint): Uint8Array => {
  const prefix = new TextEncoder().encode("snap");
  const buf = new Uint8Array(prefix.length + 8);
  buf.set(prefix);
  const view = new DataView(buf.buffer, buf.byteOffset);
  view.setBigUint64(prefix.length, slot);
  return buf;
};

export const writeSnapshot = (snapshot: LedgerStateSnapshot) =>
  Effect.gen(function* () {
    const db = yield* SqliteDrizzle;
    const store = yield* BlobStore;

    // BlobStore put + SQL insert are independent — run in parallel
    yield* Effect.all(
      [
        store.put(snapshotBlobKey(snapshot.slot), snapshot.stateBytes),
        query(
          db
            .insert(schema.ledgerSnapshots)
            .values({
              slot: Number(snapshot.slot),
              hash: buf(snapshot.point.hash),
              epoch: Number(snapshot.epoch),
            })
            .onConflictDoUpdate({
              target: schema.ledgerSnapshots.slot,
              set: { hash: buf(snapshot.point.hash) },
            }),
        ),
      ],
      { concurrency: "unbounded" },
    );
  }).pipe(Effect.mapError((cause) => new LedgerDBError({ operation: "writeSnapshot", cause })));

export const readLatestSnapshot = Effect.gen(function* () {
  const db = yield* SqliteDrizzle;
  const store = yield* BlobStore;

  const rows = yield* query(
    db.select().from(schema.ledgerSnapshots).orderBy(desc(schema.ledgerSnapshots.slot)).limit(1),
  );
  if (rows.length === 0) return Option.none<LedgerStateSnapshot>();
  const r = rows[0]!;

  const stateBytes = yield* store.get(snapshotBlobKey(BigInt(r.slot)));
  if (Option.isNone(stateBytes)) return Option.none<LedgerStateSnapshot>();

  const snapshot = {
    point: { slot: BigInt(r.slot), hash: u8(r.hash) },
    stateBytes: stateBytes.value,
    epoch: BigInt(r.epoch),
    slot: BigInt(r.slot),
  };
  return Option.some<LedgerStateSnapshot>(snapshot);
}).pipe(Effect.mapError((cause) => new LedgerDBError({ operation: "readLatestSnapshot", cause })));
