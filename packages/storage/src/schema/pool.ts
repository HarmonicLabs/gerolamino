/**
 * Stake-pool + delegation tables — defined for shape parity with
 * cardano-db-sync. Currently never written to.
 */
import { index, integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { tx, stakeAddress, redeemer } from "./tx.ts";
import { bytes } from "./columns.ts";

export const pool = sqliteTable("pool", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hashRaw: bytes("hash_raw").notNull().unique(),
  view: text("view").notNull(),
});

export const poolMetadataRef = sqliteTable("pool_metadata_ref", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  poolId: integer("pool_id")
    .notNull()
    .references(() => pool.id),
  url: text("url").notNull(),
  hash: bytes("hash").notNull(),
  registeredTxId: integer("registered_tx_id")
    .notNull()
    .references(() => tx.id),
});

export const poolUpdate = sqliteTable(
  "pool_update",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    hashId: integer("hash_id")
      .notNull()
      .references(() => pool.id),
    certIndex: integer("cert_index").notNull(),
    vrfKeyHash: bytes("vrf_key_hash").notNull(),
    pledge: integer("pledge").notNull(),
    rewardAddr: bytes("reward_addr").notNull(),
    activeEpochNo: integer("active_epoch_no").notNull(),
    metaId: integer("meta_id").references(() => poolMetadataRef.id),
    margin: real("margin").notNull(),
    fixedCost: integer("fixed_cost").notNull(),
    registeredTxId: integer("registered_tx_id")
      .notNull()
      .references(() => tx.id),
    deposit: integer("deposit"),
  },
  (t) => [unique().on(t.hashId, t.registeredTxId)],
);

export const poolRetire = sqliteTable("pool_retire", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hashId: integer("hash_id")
    .notNull()
    .references(() => pool.id),
  certIndex: integer("cert_index").notNull(),
  announcedTxId: integer("announced_tx_id")
    .notNull()
    .references(() => tx.id),
  retiringEpoch: integer("retiring_epoch").notNull(),
});

export const stakeRegistration = sqliteTable(
  "stake_registration",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    addrId: integer("addr_id")
      .notNull()
      .references(() => stakeAddress.id),
    certIndex: integer("cert_index").notNull(),
    epochNo: integer("epoch_no").notNull(),
    txId: integer("tx_id")
      .notNull()
      .references(() => tx.id),
    deposit: integer("deposit"),
  },
  (t) => [unique().on(t.addrId, t.txId)],
);

export const stakeDeregistration = sqliteTable(
  "stake_deregistration",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    addrId: integer("addr_id")
      .notNull()
      .references(() => stakeAddress.id),
    certIndex: integer("cert_index").notNull(),
    epochNo: integer("epoch_no").notNull(),
    txId: integer("tx_id")
      .notNull()
      .references(() => tx.id),
    redeemerId: integer("redeemer_id").references(() => redeemer.id),
  },
  (t) => [unique().on(t.addrId, t.txId)],
);

export const delegation = sqliteTable(
  "delegation",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    addrId: integer("addr_id")
      .notNull()
      .references(() => stakeAddress.id),
    certIndex: integer("cert_index").notNull(),
    poolHashId: integer("pool_hash_id")
      .notNull()
      .references(() => pool.id),
    activeEpochNo: integer("active_epoch_no").notNull(),
    txId: integer("tx_id")
      .notNull()
      .references(() => tx.id),
    slotNo: integer("slot_no").notNull(),
    redeemerId: integer("redeemer_id").references(() => redeemer.id),
  },
  (t) => [index("idx_delegation_addr").on(t.addrId), index("idx_delegation_pool").on(t.poolHashId)],
);
