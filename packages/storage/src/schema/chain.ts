/**
 * Chain-state tables — the five exercised at runtime.
 *
 * `slotLeader` is referenced by `immutableBlocks.slotLeaderId` (FK), and
 * `0002_…_default_slot_leader` seeds row id 0 with description "unknown"
 * so the FK is satisfied for blocks whose leader hasn't been resolved
 * yet (currently every block — leader resolution is future work).
 *
 * The other 28 Cardano-ledger tables (tx, pool, epoch, gov, …) are
 * defined in their own files for completeness but never written to —
 * they'll be exercised once full-node mode lands.
 */
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { bytes } from "./columns.ts";

export const slotLeader = sqliteTable("slot_leader", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hash: bytes("hash").notNull().unique(),
  poolHashId: integer("pool_hash_id"),
  description: text("description").notNull(),
});

export const immutableBlocks = sqliteTable(
  "immutable_blocks",
  {
    slot: integer("slot").primaryKey(),
    hash: bytes("hash").notNull().unique(),
    prevHash: bytes("prev_hash"),
    blockNo: integer("block_no").notNull(),
    epochNo: integer("epoch_no"),
    epochSlotNo: integer("epoch_slot_no"),
    txCount: integer("tx_count").notNull().default(0),
    size: integer("size").notNull(),
    time: integer("time").notNull(),
    slotLeaderId: integer("slot_leader_id")
      .notNull()
      .references(() => slotLeader.id),
    protoMajor: integer("proto_major").notNull(),
    protoMinor: integer("proto_minor").notNull(),
    vrfKey: text("vrf_key"),
    opCert: bytes("op_cert"),
    opCertCounter: integer("op_cert_counter"),
    crc32: integer("crc32"),
  },
  (t) => [
    index("idx_immutable_block_no").on(t.blockNo),
    index("idx_immutable_epoch").on(t.epochNo),
  ],
);

export const volatileBlocks = sqliteTable(
  "volatile_blocks",
  {
    hash: bytes("hash").primaryKey(),
    slot: integer("slot").notNull(),
    prevHash: bytes("prev_hash"),
    blockNo: integer("block_no").notNull(),
    blockSizeBytes: integer("block_size_bytes").notNull(),
  },
  (t) => [index("idx_volatile_prev_hash").on(t.prevHash), index("idx_volatile_slot").on(t.slot)],
);

export const ledgerSnapshots = sqliteTable("ledger_snapshots", {
  slot: integer("slot").primaryKey(),
  hash: bytes("hash").notNull(),
  epoch: integer("epoch").notNull(),
});

export const nonces = sqliteTable("nonces", {
  epoch: integer("epoch").primaryKey(),
  active: bytes("active").notNull(),
  evolving: bytes("evolving").notNull(),
  candidate: bytes("candidate").notNull(),
});
