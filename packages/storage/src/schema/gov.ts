/**
 * Conway governance tables — defined for shape parity with cardano-db-sync.
 * Currently never written to.
 */
import { blob, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { immutableBlocks } from "./chain.ts";
import { tx, stakeAddress } from "./tx.ts";
import { pool } from "./pool.ts";

export const drepHash = sqliteTable(
  "drep_hash",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    raw: blob("raw", { mode: "buffer" }),
    view: text("view").notNull(),
    hasScript: integer("has_script").notNull(),
  },
  (t) => [unique().on(t.raw, t.hasScript)],
);

export const votingAnchor = sqliteTable(
  "voting_anchor",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    url: text("url").notNull(),
    dataHash: blob("data_hash", { mode: "buffer" }).notNull(),
    type: text("type").notNull(),
    blockId: integer("block_id")
      .notNull()
      .references(() => immutableBlocks.slot),
  },
  (t) => [unique().on(t.dataHash, t.url, t.type)],
);

export const govActionProposal = sqliteTable("gov_action_proposal", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  txId: integer("tx_id")
    .notNull()
    .references(() => tx.id),
  index: integer("index").notNull(),
  prevGovActionProposal: integer("prev_gov_action_proposal"),
  deposit: integer("deposit").notNull(),
  returnAddress: integer("return_address")
    .notNull()
    .references(() => stakeAddress.id),
  expiration: integer("expiration"),
  votingAnchorId: integer("voting_anchor_id").references(() => votingAnchor.id),
  type: text("type").notNull(),
  description: text("description").notNull(),
  paramProposal: integer("param_proposal"),
  ratifiedEpoch: integer("ratified_epoch"),
  enactedEpoch: integer("enacted_epoch"),
  droppedEpoch: integer("dropped_epoch"),
  expiredEpoch: integer("expired_epoch"),
});

export const committeeHash = sqliteTable(
  "committee_hash",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    raw: blob("raw", { mode: "buffer" }).notNull(),
    hasScript: integer("has_script").notNull(),
  },
  (t) => [unique().on(t.raw, t.hasScript)],
);

export const votingProcedure = sqliteTable(
  "voting_procedure",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    txId: integer("tx_id")
      .notNull()
      .references(() => tx.id),
    index: integer("index").notNull(),
    govActionProposalId: integer("gov_action_proposal_id")
      .notNull()
      .references(() => govActionProposal.id),
    voterRole: text("voter_role").notNull(),
    committeeVoter: integer("committee_voter").references(() => committeeHash.id),
    drepVoter: integer("drep_voter").references(() => drepHash.id),
    poolVoter: integer("pool_voter").references(() => pool.id),
    vote: text("vote").notNull(),
    votingAnchorId: integer("voting_anchor_id").references(() => votingAnchor.id),
  },
  (t) => [index("idx_voting_procedure_gov").on(t.govActionProposalId)],
);

export const constitution = sqliteTable("constitution", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  govActionProposalId: integer("gov_action_proposal_id").references(() => govActionProposal.id),
  votingAnchorId: integer("voting_anchor_id")
    .notNull()
    .references(() => votingAnchor.id),
  scriptHash: blob("script_hash", { mode: "buffer" }),
});
