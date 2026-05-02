/**
 * Transaction-related tables — defined for shape parity with cardano-db-sync.
 * Currently never written to; full-node mode will exercise them.
 */
import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { immutableBlocks } from "./chain.ts";
import { bytes } from "./columns.ts";

export const tx = sqliteTable(
  "tx",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    hash: bytes("hash").notNull().unique(),
    blockSlot: integer("block_slot")
      .notNull()
      .references(() => immutableBlocks.slot),
    blockIndex: integer("block_index").notNull(),
    outSum: integer("out_sum").notNull(),
    fee: integer("fee").notNull(),
    deposit: integer("deposit").notNull().default(0),
    size: integer("size").notNull(),
    invalidBefore: integer("invalid_before"),
    invalidHereafter: integer("invalid_hereafter"),
    validContract: integer("valid_contract").notNull().default(1),
    scriptSize: integer("script_size").notNull().default(0),
    treasuryDonation: integer("treasury_donation").notNull().default(0),
  },
  (t) => [index("idx_tx_block").on(t.blockSlot)],
);

export const txCbor = sqliteTable("tx_cbor", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  txId: integer("tx_id")
    .notNull()
    .references(() => tx.id),
  bytes: bytes("bytes").notNull(),
});

export const stakeAddress = sqliteTable("stake_address", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hashRaw: bytes("hash_raw").notNull().unique(),
  view: text("view").notNull(),
  scriptHash: bytes("script_hash"),
  registeredTxId: integer("registered_tx_id")
    .notNull()
    .references(() => tx.id),
});

export const script = sqliteTable("script", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  txId: integer("tx_id")
    .notNull()
    .references(() => tx.id),
  hash: bytes("hash").notNull().unique(),
  type: text("type").notNull(),
  json: text("json"),
  bytes: bytes("bytes"),
  serialisedSize: integer("serialised_size"),
});

export const datum = sqliteTable("datum", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hash: bytes("hash").notNull().unique(),
  txId: integer("tx_id")
    .notNull()
    .references(() => tx.id),
  value: text("value"),
  bytes: bytes("bytes"),
});

export const txOut = sqliteTable(
  "tx_out",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    txId: integer("tx_id")
      .notNull()
      .references(() => tx.id),
    index: integer("index").notNull(),
    address: text("address").notNull(),
    addressRaw: bytes("address_raw").notNull(),
    addressHasScript: integer("address_has_script").notNull(),
    paymentCred: bytes("payment_cred"),
    stakeAddressId: integer("stake_address_id").references(() => stakeAddress.id),
    value: integer("value").notNull(),
    dataHash: bytes("data_hash"),
    inlineDatumId: integer("inline_datum_id").references(() => datum.id),
    referenceScriptId: integer("reference_script_id").references(() => script.id),
    consumedByTxId: integer("consumed_by_tx_id").references(() => tx.id),
  },
  (t) => [
    unique().on(t.txId, t.index),
    index("idx_tx_out_address").on(t.addressRaw),
    index("idx_tx_out_payment_cred").on(t.paymentCred),
    index("idx_tx_out_consumed").on(t.consumedByTxId),
  ],
);

export const redeemer = sqliteTable(
  "redeemer",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    txId: integer("tx_id")
      .notNull()
      .references(() => tx.id),
    unitMem: integer("unit_mem").notNull(),
    unitSteps: integer("unit_steps").notNull(),
    fee: integer("fee").notNull(),
    purpose: text("purpose").notNull(),
    index: integer("index").notNull(),
    scriptHash: bytes("script_hash"),
    datumId: integer("datum_id")
      .notNull()
      .references(() => datum.id),
  },
  (t) => [unique().on(t.txId, t.purpose, t.index)],
);

export const txIn = sqliteTable(
  "tx_in",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    txInId: integer("tx_in_id")
      .notNull()
      .references(() => tx.id),
    txOutId: integer("tx_out_id")
      .notNull()
      .references(() => tx.id),
    txOutIndex: integer("tx_out_index").notNull(),
    redeemerId: integer("redeemer_id").references(() => redeemer.id),
  },
  (t) => [unique().on(t.txOutId, t.txOutIndex)],
);

export const collateralTxIn = sqliteTable(
  "collateral_tx_in",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    txInId: integer("tx_in_id")
      .notNull()
      .references(() => tx.id),
    txOutId: integer("tx_out_id")
      .notNull()
      .references(() => tx.id),
    txOutIndex: integer("tx_out_index").notNull(),
  },
  (t) => [unique().on(t.txInId, t.txOutId, t.txOutIndex)],
);

export const collateralTxOut = sqliteTable("collateral_tx_out", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  txId: integer("tx_id")
    .notNull()
    .references(() => tx.id),
  index: integer("index").notNull(),
  address: text("address").notNull(),
  addressRaw: bytes("address_raw").notNull(),
  addressHasScript: integer("address_has_script").notNull(),
  paymentCred: bytes("payment_cred"),
  stakeAddressId: integer("stake_address_id").references(() => stakeAddress.id),
  value: integer("value").notNull(),
  dataHash: bytes("data_hash"),
  multiAssetsDescr: text("multi_assets_descr").notNull(),
  inlineDatumId: integer("inline_datum_id").references(() => datum.id),
  referenceScriptId: integer("reference_script_id").references(() => script.id),
});

export const referenceTxIn = sqliteTable("reference_tx_in", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  txInId: integer("tx_in_id")
    .notNull()
    .references(() => tx.id),
  txOutId: integer("tx_out_id")
    .notNull()
    .references(() => tx.id),
  txOutIndex: integer("tx_out_index").notNull(),
});

export const multiAsset = sqliteTable(
  "multi_asset",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    policy: bytes("policy").notNull(),
    name: bytes("name").notNull(),
    fingerprint: text("fingerprint").notNull(),
  },
  (t) => [unique().on(t.policy, t.name)],
);

export const maTxMint = sqliteTable(
  "ma_tx_mint",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    quantity: integer("quantity").notNull(),
    txId: integer("tx_id")
      .notNull()
      .references(() => tx.id),
    ident: integer("ident")
      .notNull()
      .references(() => multiAsset.id),
  },
  (t) => [unique().on(t.ident, t.txId)],
);

export const maTxOut = sqliteTable(
  "ma_tx_out",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    quantity: integer("quantity").notNull(),
    txOutId: integer("tx_out_id")
      .notNull()
      .references(() => txOut.id),
    ident: integer("ident")
      .notNull()
      .references(() => multiAsset.id),
  },
  (t) => [unique().on(t.ident, t.txOutId)],
);

export const txMetadata = sqliteTable(
  "tx_metadata",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    key: integer("key").notNull(),
    json: text("json"),
    bytes: bytes("bytes").notNull(),
    txId: integer("tx_id")
      .notNull()
      .references(() => tx.id),
  },
  (t) => [unique().on(t.key, t.txId)],
);
