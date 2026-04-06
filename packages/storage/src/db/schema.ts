/**
 * Drizzle ORM schema — complete ChainDB following cardano-db-sync (up to migration-2-0045).
 *
 * Single source of truth for the database schema. All queries use Drizzle's
 * type-safe query builder. Migrations generated via `drizzle-kit generate`.
 *
 * Naming: snake_case in DB, camelCase in TypeScript (Drizzle maps automatically).
 */
import {
  sqliteTable,
  integer,
  text,
  blob,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

// =============================================================================
// Core Chain — Blocks & Slot Leaders
// =============================================================================

export const slotLeader = sqliteTable("slot_leader", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hash: blob("hash", { mode: "buffer" }).notNull().unique(),
  poolHashId: integer("pool_hash_id").references(() => pool.id),
  description: text("description").notNull(),
});

export const immutableBlocks = sqliteTable(
  "immutable_blocks",
  {
    slot: integer("slot").primaryKey(),
    hash: blob("hash", { mode: "buffer" }).notNull().unique(),
    prevHash: blob("prev_hash", { mode: "buffer" }),
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
    opCert: blob("op_cert", { mode: "buffer" }),
    opCertCounter: integer("op_cert_counter"),
    crc32: integer("crc32"),
    // blockCbor moved to BlobStore (LSM / IndexedDB) under blk: prefix key
  },
  (t) => ({
    blockNoIdx: index("idx_immutable_block_no").on(t.blockNo),
    epochIdx: index("idx_immutable_epoch").on(t.epochNo),
  }),
);

export const volatileBlocks = sqliteTable(
  "volatile_blocks",
  {
    hash: blob("hash", { mode: "buffer" }).primaryKey(),
    slot: integer("slot").notNull(),
    prevHash: blob("prev_hash", { mode: "buffer" }),
    blockNo: integer("block_no").notNull(),
    blockSizeBytes: integer("block_size_bytes").notNull(),
    // blockCbor moved to BlobStore (LSM / IndexedDB) under blk: prefix key
  },
  (t) => ({
    prevHashIdx: index("idx_volatile_prev_hash").on(t.prevHash),
  }),
);

export const ledgerSnapshots = sqliteTable("ledger_snapshots", {
  slot: integer("slot").primaryKey(),
  hash: blob("hash", { mode: "buffer" }).notNull(),
  epoch: integer("epoch").notNull(),
  // stateBytes moved to BlobStore under "snap" prefix key
});

// =============================================================================
// Transactions
// =============================================================================

export const tx = sqliteTable(
  "tx",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    hash: blob("hash", { mode: "buffer" }).notNull().unique(),
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
  (t) => ({
    blockSlotIdx: index("idx_tx_block").on(t.blockSlot),
  }),
);

export const txCbor = sqliteTable("tx_cbor", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  txId: integer("tx_id")
    .notNull()
    .references(() => tx.id),
  bytes: blob("bytes", { mode: "buffer" }).notNull(),
});

// =============================================================================
// UTxO — Outputs, Inputs, Collateral, References
// =============================================================================

export const stakeAddress = sqliteTable("stake_address", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hashRaw: blob("hash_raw", { mode: "buffer" }).notNull().unique(),
  view: text("view").notNull(),
  scriptHash: blob("script_hash", { mode: "buffer" }),
  registeredTxId: integer("registered_tx_id")
    .notNull()
    .references(() => tx.id),
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
    addressRaw: blob("address_raw", { mode: "buffer" }).notNull(),
    addressHasScript: integer("address_has_script").notNull(),
    paymentCred: blob("payment_cred", { mode: "buffer" }),
    stakeAddressId: integer("stake_address_id").references(() => stakeAddress.id),
    value: integer("value").notNull(),
    dataHash: blob("data_hash", { mode: "buffer" }),
    inlineDatumId: integer("inline_datum_id").references(() => datum.id),
    referenceScriptId: integer("reference_script_id").references(() => script.id),
    consumedByTxId: integer("consumed_by_tx_id").references(() => tx.id),
  },
  (t) => ({
    txIdIndexUnique: uniqueIndex("tx_out_unique").on(t.txId, t.index),
    addressIdx: index("idx_tx_out_address").on(t.addressRaw),
    paymentCredIdx: index("idx_tx_out_payment_cred").on(t.paymentCred),
    stakeAddrIdx: index("idx_tx_out_stake_address").on(t.stakeAddressId),
    consumedIdx: index("idx_tx_out_consumed").on(t.consumedByTxId),
  }),
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
  (t) => ({
    txInUnique: uniqueIndex("tx_in_unique").on(t.txOutId, t.txOutIndex),
  }),
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
  (t) => ({
    colTxInUnique: uniqueIndex("col_txin_unique").on(t.txInId, t.txOutId, t.txOutIndex),
  }),
);

export const collateralTxOut = sqliteTable("collateral_tx_out", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  txId: integer("tx_id")
    .notNull()
    .references(() => tx.id),
  index: integer("index").notNull(),
  address: text("address").notNull(),
  addressRaw: blob("address_raw", { mode: "buffer" }).notNull(),
  addressHasScript: integer("address_has_script").notNull(),
  paymentCred: blob("payment_cred", { mode: "buffer" }),
  stakeAddressId: integer("stake_address_id").references(() => stakeAddress.id),
  value: integer("value").notNull(),
  dataHash: blob("data_hash", { mode: "buffer" }),
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

// =============================================================================
// Multi-Asset (Native Tokens)
// =============================================================================

export const multiAsset = sqliteTable(
  "multi_asset",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    policy: blob("policy", { mode: "buffer" }).notNull(),
    name: blob("name", { mode: "buffer" }).notNull(),
    fingerprint: text("fingerprint").notNull(),
  },
  (t) => ({
    policyNameUnique: uniqueIndex("multi_asset_unique").on(t.policy, t.name),
  }),
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
  (t) => ({
    mintUnique: uniqueIndex("ma_tx_mint_unique").on(t.ident, t.txId),
  }),
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
  (t) => ({
    maOutUnique: uniqueIndex("ma_tx_out_unique").on(t.ident, t.txOutId),
  }),
);

// =============================================================================
// Scripts, Datums & Redeemers
// =============================================================================

export const script = sqliteTable("script", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  txId: integer("tx_id")
    .notNull()
    .references(() => tx.id),
  hash: blob("hash", { mode: "buffer" }).notNull().unique(),
  type: text("type").notNull(),
  json: text("json"),
  bytes: blob("bytes", { mode: "buffer" }),
  serialisedSize: integer("serialised_size"),
});

export const datum = sqliteTable("datum", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hash: blob("hash", { mode: "buffer" }).notNull().unique(),
  txId: integer("tx_id")
    .notNull()
    .references(() => tx.id),
  value: text("value"),
  bytes: blob("bytes", { mode: "buffer" }),
});

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
    scriptHash: blob("script_hash", { mode: "buffer" }),
    datumId: integer("datum_id")
      .notNull()
      .references(() => datum.id),
  },
  (t) => ({
    redeemerUnique: uniqueIndex("redeemer_unique").on(t.txId, t.purpose, t.index),
  }),
);

export const redeemerData = sqliteTable("redeemer_data", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hash: blob("hash", { mode: "buffer" }).notNull().unique(),
  txId: integer("tx_id")
    .notNull()
    .references(() => tx.id),
  value: text("value"),
  bytes: blob("bytes", { mode: "buffer" }),
});

export const costModel = sqliteTable("cost_model", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  costs: text("costs").notNull(),
  hash: blob("hash", { mode: "buffer" }).notNull().unique(),
});

export const extraKeyWitness = sqliteTable("extra_key_witness", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hash: blob("hash", { mode: "buffer" }).notNull(),
  txId: integer("tx_id")
    .notNull()
    .references(() => tx.id),
});

export const txMetadata = sqliteTable(
  "tx_metadata",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    key: integer("key").notNull(),
    json: text("json"),
    bytes: blob("bytes", { mode: "buffer" }).notNull(),
    txId: integer("tx_id")
      .notNull()
      .references(() => tx.id),
  },
  (t) => ({
    txKeyUnique: uniqueIndex("tx_metadata_unique").on(t.key, t.txId),
  }),
);

// =============================================================================
// Stake & Delegation
// =============================================================================

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
  (t) => ({
    stakeRegUnique: uniqueIndex("stake_registration_unique").on(t.addrId, t.txId),
  }),
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
  (t) => ({
    stakeDeregUnique: uniqueIndex("stake_deregistration_unique").on(t.addrId, t.txId),
  }),
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
  (t) => ({
    delegStakeIdx: index("idx_delegation_addr").on(t.addrId),
    delegPoolIdx: index("idx_delegation_pool").on(t.poolHashId),
  }),
);

// =============================================================================
// Pools
// =============================================================================

export const pool = sqliteTable("pool", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hashRaw: blob("hash_raw", { mode: "buffer" }).notNull().unique(),
  view: text("view").notNull(),
});

export const poolUpdate = sqliteTable(
  "pool_update",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    hashId: integer("hash_id")
      .notNull()
      .references(() => pool.id),
    certIndex: integer("cert_index").notNull(),
    vrfKeyHash: blob("vrf_key_hash", { mode: "buffer" }).notNull(),
    pledge: integer("pledge").notNull(),
    rewardAddr: blob("reward_addr", { mode: "buffer" }).notNull(),
    activeEpochNo: integer("active_epoch_no").notNull(),
    metaId: integer("meta_id").references(() => poolMetadataRef.id),
    margin: real("margin").notNull(),
    fixedCost: integer("fixed_cost").notNull(),
    registeredTxId: integer("registered_tx_id")
      .notNull()
      .references(() => tx.id),
    deposit: integer("deposit"),
  },
  (t) => ({
    poolUpdateUnique: uniqueIndex("pool_update_unique").on(t.hashId, t.registeredTxId),
  }),
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

export const poolOwner = sqliteTable("pool_owner", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  addrId: integer("addr_id")
    .notNull()
    .references(() => stakeAddress.id),
  poolUpdateId: integer("pool_update_id")
    .notNull()
    .references(() => poolUpdate.id),
});

export const poolRelay = sqliteTable("pool_relay", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  updateId: integer("update_id")
    .notNull()
    .references(() => poolUpdate.id),
  ipv4: text("ipv4"),
  ipv6: text("ipv6"),
  dnsName: text("dns_name"),
  dnsSrvName: text("dns_srv_name"),
  port: integer("port"),
});

export const poolMetadataRef = sqliteTable("pool_metadata_ref", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  poolId: integer("pool_id")
    .notNull()
    .references(() => pool.id),
  url: text("url").notNull(),
  hash: blob("hash", { mode: "buffer" }).notNull(),
  registeredTxId: integer("registered_tx_id")
    .notNull()
    .references(() => tx.id),
});

export const poolStat = sqliteTable(
  "pool_stat",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    poolHashId: integer("pool_hash_id")
      .notNull()
      .references(() => pool.id),
    epochNo: integer("epoch_no").notNull(),
    numberOfBlocks: integer("number_of_blocks").notNull(),
    numberOfDelegators: integer("number_of_delegators").notNull(),
    stake: integer("stake").notNull(),
    votingPower: integer("voting_power"),
  },
  (t) => ({
    poolStatUnique: uniqueIndex("pool_stat_unique").on(t.poolHashId, t.epochNo),
  }),
);

// =============================================================================
// Epochs, Stake Distribution & Protocol Parameters
// =============================================================================

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
  (t) => ({
    epochStakeIdx: index("idx_epoch_stake_epoch").on(t.epochNo),
    epochStakePoolIdx: index("idx_epoch_stake_pool").on(t.poolId),
  }),
);

export const epochNonce = sqliteTable("epoch_nonce", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  epochNo: integer("epoch_no").notNull().unique(),
  nonce: blob("nonce", { mode: "buffer" }),
  evolvingNonce: blob("evolving_nonce", { mode: "buffer" }),
  candidateNonce: blob("candidate_nonce", { mode: "buffer" }),
});

export const epochParam = sqliteTable("epoch_param", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  epochNo: integer("epoch_no").notNull().unique(),
  minFeeA: integer("min_fee_a").notNull(),
  minFeeB: integer("min_fee_b").notNull(),
  maxBlockSize: integer("max_block_size").notNull(),
  maxTxSize: integer("max_tx_size").notNull(),
  maxBhSize: integer("max_bh_size").notNull(),
  keyDeposit: integer("key_deposit").notNull(),
  poolDeposit: integer("pool_deposit").notNull(),
  maxEpoch: integer("max_epoch").notNull(),
  optimalPoolCount: integer("optimal_pool_count").notNull(),
  influence: real("influence").notNull(),
  monetaryExpandRate: real("monetary_expand_rate").notNull(),
  treasuryGrowthRate: real("treasury_growth_rate").notNull(),
  decentralisation: real("decentralisation").notNull(),
  protocolMajor: integer("protocol_major").notNull(),
  protocolMinor: integer("protocol_minor").notNull(),
  minUtxoValue: integer("min_utxo_value").notNull(),
  minPoolCost: integer("min_pool_cost").notNull(),
  nonce: blob("nonce", { mode: "buffer" }),
  coinsPerUtxoSize: integer("coins_per_utxo_size"),
  costModelId: integer("cost_model_id").references(() => costModel.id),
  priceMem: real("price_mem"),
  priceStep: real("price_step"),
  maxTxExMem: integer("max_tx_ex_mem"),
  maxTxExSteps: integer("max_tx_ex_steps"),
  maxBlockExMem: integer("max_block_ex_mem"),
  maxBlockExSteps: integer("max_block_ex_steps"),
  maxValSize: integer("max_val_size"),
  collateralPercent: integer("collateral_percent"),
  maxCollateralInputs: integer("max_collateral_inputs"),
  blockId: integer("block_id")
    .notNull()
    .references(() => immutableBlocks.slot),
  // Conway governance thresholds
  pvtMotionNoConfidence: real("pvt_motion_no_confidence"),
  pvtCommitteeNormal: real("pvt_committee_normal"),
  pvtCommitteeNoConfidence: real("pvt_committee_no_confidence"),
  pvtHardForkInitiation: real("pvt_hard_fork_initiation"),
  pvtppSecurityGroup: real("pvtpp_security_group"),
  dvtMotionNoConfidence: real("dvt_motion_no_confidence"),
  dvtCommitteeNormal: real("dvt_committee_normal"),
  dvtCommitteeNoConfidence: real("dvt_committee_no_confidence"),
  dvtUpdateToConstitution: real("dvt_update_to_constitution"),
  dvtHardForkInitiation: real("dvt_hard_fork_initiation"),
  dvtPPNetworkGroup: real("dvt_p_p_network_group"),
  dvtPPEconomicGroup: real("dvt_p_p_economic_group"),
  dvtPPTechnicalGroup: real("dvt_p_p_technical_group"),
  dvtPPGovGroup: real("dvt_p_p_gov_group"),
  dvtTreasuryWithdrawal: real("dvt_treasury_withdrawal"),
  committeeMinSize: integer("committee_min_size"),
  committeeMaxTermLength: integer("committee_max_term_length"),
  govActionLifetime: integer("gov_action_lifetime"),
  govActionDeposit: integer("gov_action_deposit"),
  drepDeposit: integer("drep_deposit"),
  drepActivity: integer("drep_activity"),
  minFeeRefScriptCostPerByte: real("min_fee_ref_script_cost_per_byte"),
});

// =============================================================================
// Rewards, Withdrawals & ADA Pots
// =============================================================================

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
  (t) => ({
    rewardAddrIdx: index("idx_reward_addr").on(t.addrId, t.earnedEpoch),
  }),
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
  (t) => ({
    withdrawalUnique: uniqueIndex("withdrawal_unique").on(t.addrId, t.txId),
  }),
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

// =============================================================================
// Governance (Conway Era)
// =============================================================================

export const drepHash = sqliteTable(
  "drep_hash",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    raw: blob("raw", { mode: "buffer" }),
    view: text("view").notNull(),
    hasScript: integer("has_script").notNull(),
  },
  (t) => ({
    drepHashUnique: uniqueIndex("drep_hash_unique").on(t.raw, t.hasScript),
  }),
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
  (t) => ({
    votingAnchorUnique: uniqueIndex("voting_anchor_unique").on(t.dataHash, t.url, t.type),
  }),
);

export const drepRegistration = sqliteTable("drep_registration", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  txId: integer("tx_id")
    .notNull()
    .references(() => tx.id),
  certIndex: integer("cert_index").notNull(),
  deposit: integer("deposit"),
  drepHashId: integer("drep_hash_id")
    .notNull()
    .references(() => drepHash.id),
  votingAnchorId: integer("voting_anchor_id").references(() => votingAnchor.id),
});

export const delegationVote = sqliteTable("delegation_vote", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  addrId: integer("addr_id")
    .notNull()
    .references(() => stakeAddress.id),
  certIndex: integer("cert_index").notNull(),
  drepHashId: integer("drep_hash_id")
    .notNull()
    .references(() => drepHash.id),
  txId: integer("tx_id")
    .notNull()
    .references(() => tx.id),
  redeemerId: integer("redeemer_id").references(() => redeemer.id),
});

export const drepDistr = sqliteTable(
  "drep_distr",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    hashId: integer("hash_id")
      .notNull()
      .references(() => drepHash.id),
    amount: integer("amount").notNull(),
    epochNo: integer("epoch_no").notNull(),
    activeUntil: integer("active_until"),
  },
  (t) => ({
    drepDistrUnique: uniqueIndex("drep_distr_unique").on(t.hashId, t.epochNo),
  }),
);

export const govActionProposal = sqliteTable("gov_action_proposal", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  txId: integer("tx_id")
    .notNull()
    .references(() => tx.id),
  index: integer("index").notNull(),
  prevGovActionProposal: integer("prev_gov_action_proposal").references(
    (): any => govActionProposal.id,
  ),
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

export const treasuryWithdrawal = sqliteTable("treasury_withdrawal", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  govActionProposalId: integer("gov_action_proposal_id")
    .notNull()
    .references(() => govActionProposal.id),
  stakeAddressId: integer("stake_address_id")
    .notNull()
    .references(() => stakeAddress.id),
  amount: integer("amount").notNull(),
});

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
  (t) => ({
    voteProcIdx: index("idx_voting_procedure_gov").on(t.govActionProposalId),
  }),
);

export const committeeHash = sqliteTable(
  "committee_hash",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    raw: blob("raw", { mode: "buffer" }).notNull(),
    hasScript: integer("has_script").notNull(),
  },
  (t) => ({
    committeeHashUnique: uniqueIndex("committee_hash_unique").on(t.raw, t.hasScript),
  }),
);

export const committeeRegistration = sqliteTable("committee_registration", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  txId: integer("tx_id")
    .notNull()
    .references(() => tx.id),
  certIndex: integer("cert_index").notNull(),
  coldKeyId: integer("cold_key_id")
    .notNull()
    .references(() => committeeHash.id),
  hotKeyId: integer("hot_key_id")
    .notNull()
    .references(() => committeeHash.id),
});

export const committeeDeRegistration = sqliteTable("committee_de_registration", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  txId: integer("tx_id")
    .notNull()
    .references(() => tx.id),
  certIndex: integer("cert_index").notNull(),
  coldKeyId: integer("cold_key_id")
    .notNull()
    .references(() => committeeHash.id),
  votingAnchorId: integer("voting_anchor_id").references(() => votingAnchor.id),
});

export const constitution = sqliteTable("constitution", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  govActionProposalId: integer("gov_action_proposal_id").references(() => govActionProposal.id),
  votingAnchorId: integer("voting_anchor_id")
    .notNull()
    .references(() => votingAnchor.id),
  scriptHash: blob("script_hash", { mode: "buffer" }),
});

export const epochState = sqliteTable("epoch_state", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  committeeId: integer("committee_id"),
  noConfidenceId: integer("no_confidence_id"),
  constitutionId: integer("constitution_id").references(() => constitution.id),
  epochNo: integer("epoch_no").notNull(),
});

// =============================================================================
// Drizzle Relations (for relational query builder)
// =============================================================================

export const immutableBlocksRelations = relations(immutableBlocks, ({ one, many }) => ({
  slotLeader: one(slotLeader, {
    fields: [immutableBlocks.slotLeaderId],
    references: [slotLeader.id],
  }),
  transactions: many(tx),
}));

export const txRelations = relations(tx, ({ one, many }) => ({
  block: one(immutableBlocks, { fields: [tx.blockSlot], references: [immutableBlocks.slot] }),
  cbor: one(txCbor),
  inputs: many(txIn),
  outputs: many(txOut),
  collateralInputs: many(collateralTxIn),
  mints: many(maTxMint),
  metadata: many(txMetadata),
}));

export const txOutRelations = relations(txOut, ({ one, many }) => ({
  tx: one(tx, { fields: [txOut.txId], references: [tx.id] }),
  stakeAddress: one(stakeAddress, {
    fields: [txOut.stakeAddressId],
    references: [stakeAddress.id],
  }),
  assets: many(maTxOut),
}));

export const txInRelations = relations(txIn, ({ one }) => ({
  spendingTx: one(tx, { fields: [txIn.txInId], references: [tx.id], relationName: "spendingTx" }),
  sourceTx: one(tx, { fields: [txIn.txOutId], references: [tx.id], relationName: "sourceTx" }),
}));

export const poolRelations = relations(pool, ({ many }) => ({
  updates: many(poolUpdate),
  retirements: many(poolRetire),
  delegations: many(delegation),
  stats: many(poolStat),
}));

export const poolUpdateRelations = relations(poolUpdate, ({ one, many }) => ({
  pool: one(pool, { fields: [poolUpdate.hashId], references: [pool.id] }),
  registeredTx: one(tx, { fields: [poolUpdate.registeredTxId], references: [tx.id] }),
  owners: many(poolOwner),
  relays: many(poolRelay),
}));

export const stakeAddressRelations = relations(stakeAddress, ({ many }) => ({
  registrations: many(stakeRegistration),
  deregistrations: many(stakeDeregistration),
  delegations: many(delegation),
  rewards: many(reward),
  epochStakes: many(epochStake),
}));

export const delegationRelations = relations(delegation, ({ one }) => ({
  stakeAddress: one(stakeAddress, { fields: [delegation.addrId], references: [stakeAddress.id] }),
  pool: one(pool, { fields: [delegation.poolHashId], references: [pool.id] }),
  tx: one(tx, { fields: [delegation.txId], references: [tx.id] }),
}));

export const govActionProposalRelations = relations(govActionProposal, ({ one, many }) => ({
  tx: one(tx, { fields: [govActionProposal.txId], references: [tx.id] }),
  votingAnchor: one(votingAnchor, {
    fields: [govActionProposal.votingAnchorId],
    references: [votingAnchor.id],
  }),
  votes: many(votingProcedure),
  treasuryWithdrawals: many(treasuryWithdrawal),
}));

// =============================================================================
// Type Inference Exports
// =============================================================================

export type ImmutableBlock = typeof immutableBlocks.$inferSelect;
export type InsertImmutableBlock = typeof immutableBlocks.$inferInsert;
export type VolatileBlock = typeof volatileBlocks.$inferSelect;
export type InsertVolatileBlock = typeof volatileBlocks.$inferInsert;
export type Tx = typeof tx.$inferSelect;
export type InsertTx = typeof tx.$inferInsert;
export type TxOutRow = typeof txOut.$inferSelect;
export type InsertTxOut = typeof txOut.$inferInsert;
export type TxInRow = typeof txIn.$inferSelect;
export type InsertTxIn = typeof txIn.$inferInsert;
export type Pool = typeof pool.$inferSelect;
export type InsertPool = typeof pool.$inferInsert;
export type PoolUpdate = typeof poolUpdate.$inferSelect;
export type InsertPoolUpdate = typeof poolUpdate.$inferInsert;
export type Epoch = typeof epoch.$inferSelect;
export type EpochStakeRow = typeof epochStake.$inferSelect;
export type InsertEpochStake = typeof epochStake.$inferInsert;
export type SlotLeader = typeof slotLeader.$inferSelect;
export type DrepHash = typeof drepHash.$inferSelect;
export type GovActionProposal = typeof govActionProposal.$inferSelect;
export type VotingProcedureRow = typeof votingProcedure.$inferSelect;
