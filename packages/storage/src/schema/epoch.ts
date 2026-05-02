/**
 * Epoch / reward / pots tables — defined for shape parity with
 * cardano-db-sync. Currently never written to.
 */
import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { immutableBlocks } from "./chain.ts";
import { tx, stakeAddress, redeemer } from "./tx.ts";
import { pool } from "./pool.ts";

export const epoch = sqliteTable("epoch", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  outSum: integer("out_sum").notNull(),
  fees: integer("fees").notNull(),
  txCount: integer("tx_count").notNull(),
  blkCount: integer("blk_count").notNull(),
  no: integer("no").notNull().unique(),
  startTime: integer("start_time").notNull(),
  endTime: integer("end_time").notNull(),
});

export const epochStake = sqliteTable(
  "epoch_stake",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    addrId: integer("addr_id")
      .notNull()
      .references(() => stakeAddress.id),
    poolId: integer("pool_id")
      .notNull()
      .references(() => pool.id),
    amount: integer("amount").notNull(),
    epochNo: integer("epoch_no").notNull(),
  },
  (t) => [index("idx_epoch_stake_epoch").on(t.epochNo), index("idx_epoch_stake_pool").on(t.poolId)],
);

export const reward = sqliteTable(
  "reward",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    addrId: integer("addr_id")
      .notNull()
      .references(() => stakeAddress.id),
    type: text("type").notNull(),
    amount: integer("amount").notNull(),
    earnedEpoch: integer("earned_epoch").notNull(),
    spendableEpoch: integer("spendable_epoch").notNull(),
    poolId: integer("pool_id").references(() => pool.id),
  },
  (t) => [index("idx_reward_addr").on(t.addrId, t.earnedEpoch)],
);

export const withdrawal = sqliteTable(
  "withdrawal",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    addrId: integer("addr_id")
      .notNull()
      .references(() => stakeAddress.id),
    amount: integer("amount").notNull(),
    redeemerId: integer("redeemer_id").references(() => redeemer.id),
    txId: integer("tx_id")
      .notNull()
      .references(() => tx.id),
  },
  (t) => [unique().on(t.addrId, t.txId)],
);

export const adaPots = sqliteTable("ada_pots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slotNo: integer("slot_no").notNull(),
  epochNo: integer("epoch_no").notNull(),
  treasury: integer("treasury").notNull(),
  reserves: integer("reserves").notNull(),
  rewards: integer("rewards").notNull(),
  utxo: integer("utxo").notNull(),
  depositsStake: integer("deposits_stake").notNull().default(0),
  depositsDrep: integer("deposits_drep").notNull().default(0),
  depositsProposal: integer("deposits_proposal").notNull().default(0),
  fees: integer("fees").notNull(),
  blockId: integer("block_id")
    .notNull()
    .unique()
    .references(() => immutableBlocks.slot),
});
