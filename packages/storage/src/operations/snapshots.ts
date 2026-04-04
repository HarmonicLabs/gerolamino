/**
 * Ledger state snapshot operations — abstract over SqlClient.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { LedgerStateSnapshot } from "../types/LedgerState.ts";
import { LedgerDBError } from "../errors.ts";

export const writeSnapshot = (snapshot: LedgerStateSnapshot) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      INSERT INTO ledger_snapshots (slot, hash, epoch, state_bytes)
      VALUES (${Number(snapshot.slot)}, ${snapshot.point.hash}, ${Number(snapshot.epoch)}, ${snapshot.stateBytes})
      ON CONFLICT(slot) DO UPDATE SET state_bytes = ${snapshot.stateBytes}
    `;
  }).pipe(Effect.mapError((cause) => new LedgerDBError({ operation: "writeSnapshot", cause })));

export const readLatestSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{
    slot: number;
    hash: Uint8Array;
    epoch: number;
    state_bytes: Uint8Array;
  }>`SELECT * FROM ledger_snapshots ORDER BY slot DESC LIMIT 1`;
  if (rows.length === 0) return undefined;
  const r = rows[0]!;
  return {
    point: { slot: BigInt(r.slot), hash: r.hash },
    stateBytes: r.state_bytes,
    epoch: BigInt(r.epoch),
    slot: BigInt(r.slot),
  } satisfies LedgerStateSnapshot;
}).pipe(Effect.mapError((cause) => new LedgerDBError({ operation: "readLatestSnapshot", cause })));
