/**
 * Database migrations using Effect's Migrator.
 *
 * Uses Migrator.fromRecord for tracked, idempotent schema creation.
 * Migrations define the canonical schema. Types in `../types/` are the reference.
 * PRAGMAs are runtime config, not schema — applied before migrations.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import * as Migrator from "effect/unstable/sql/Migrator";

/** SQLite PRAGMA setup — runtime config, not schema. */
const pragmas = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`PRAGMA journal_mode = WAL`.unprepared;
  yield* sql`PRAGMA synchronous = NORMAL`.unprepared;
  yield* sql`PRAGMA foreign_keys = ON`.unprepared;
});

const migrations = Migrator.fromRecord({
  "0001_create_core_tables": Effect.gen(function* () {
    const sql = (yield* SqlClient).withoutTransforms();

    // Core chain tables
    yield* sql`
      CREATE TABLE IF NOT EXISTS slot_leader (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash BLOB NOT NULL UNIQUE,
        pool_hash_id INTEGER,
        description TEXT NOT NULL
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS immutable_blocks (
        slot INTEGER PRIMARY KEY,
        hash BLOB NOT NULL UNIQUE,
        prev_hash BLOB,
        block_no INTEGER NOT NULL,
        epoch_no INTEGER,
        epoch_slot_no INTEGER,
        tx_count INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL,
        time INTEGER NOT NULL,
        slot_leader_id INTEGER NOT NULL REFERENCES slot_leader(id),
        proto_major INTEGER NOT NULL,
        proto_minor INTEGER NOT NULL,
        vrf_key TEXT,
        op_cert BLOB,
        op_cert_counter INTEGER,
        crc32 INTEGER
      )
    `.unprepared;

    yield* sql`CREATE INDEX IF NOT EXISTS idx_immutable_block_no ON immutable_blocks(block_no)`
      .unprepared;
    yield* sql`CREATE INDEX IF NOT EXISTS idx_immutable_epoch ON immutable_blocks(epoch_no)`
      .unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS volatile_blocks (
        hash BLOB PRIMARY KEY,
        slot INTEGER NOT NULL,
        prev_hash BLOB,
        block_no INTEGER NOT NULL,
        block_size_bytes INTEGER NOT NULL
      )
    `.unprepared;

    yield* sql`CREATE INDEX IF NOT EXISTS idx_volatile_prev_hash ON volatile_blocks(prev_hash)`
      .unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS ledger_snapshots (
        slot INTEGER PRIMARY KEY,
        hash BLOB NOT NULL,
        epoch INTEGER NOT NULL
      )
    `.unprepared;

    // Transactions
    yield* sql`
      CREATE TABLE IF NOT EXISTS tx (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash BLOB NOT NULL UNIQUE,
        block_slot INTEGER NOT NULL REFERENCES immutable_blocks(slot),
        block_index INTEGER NOT NULL,
        out_sum INTEGER NOT NULL,
        fee INTEGER NOT NULL,
        deposit INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL,
        invalid_before INTEGER,
        invalid_hereafter INTEGER,
        valid_contract INTEGER NOT NULL DEFAULT 1,
        script_size INTEGER NOT NULL DEFAULT 0,
        treasury_donation INTEGER NOT NULL DEFAULT 0
      )
    `.unprepared;

    yield* sql`CREATE INDEX IF NOT EXISTS idx_tx_block ON tx(block_slot)`.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS tx_cbor (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_id INTEGER NOT NULL REFERENCES tx(id),
        bytes BLOB NOT NULL
      )
    `.unprepared;

    // Stake addresses
    yield* sql`
      CREATE TABLE IF NOT EXISTS stake_address (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash_raw BLOB NOT NULL UNIQUE,
        view TEXT NOT NULL,
        script_hash BLOB,
        registered_tx_id INTEGER NOT NULL REFERENCES tx(id)
      )
    `.unprepared;

    // Scripts & datums
    yield* sql`
      CREATE TABLE IF NOT EXISTS script (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_id INTEGER NOT NULL REFERENCES tx(id),
        hash BLOB NOT NULL UNIQUE,
        type TEXT NOT NULL,
        json TEXT,
        bytes BLOB,
        serialised_size INTEGER
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS datum (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash BLOB NOT NULL UNIQUE,
        tx_id INTEGER NOT NULL REFERENCES tx(id),
        value TEXT,
        bytes BLOB
      )
    `.unprepared;

    // UTxO outputs
    yield* sql`
      CREATE TABLE IF NOT EXISTS tx_out (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_id INTEGER NOT NULL REFERENCES tx(id),
        "index" INTEGER NOT NULL,
        address TEXT NOT NULL,
        address_raw BLOB NOT NULL,
        address_has_script INTEGER NOT NULL,
        payment_cred BLOB,
        stake_address_id INTEGER REFERENCES stake_address(id),
        value INTEGER NOT NULL,
        data_hash BLOB,
        inline_datum_id INTEGER REFERENCES datum(id),
        reference_script_id INTEGER REFERENCES script(id),
        consumed_by_tx_id INTEGER REFERENCES tx(id),
        UNIQUE(tx_id, "index")
      )
    `.unprepared;

    yield* sql`CREATE INDEX IF NOT EXISTS idx_tx_out_address ON tx_out(address_raw)`.unprepared;
    yield* sql`CREATE INDEX IF NOT EXISTS idx_tx_out_payment_cred ON tx_out(payment_cred)`
      .unprepared;
    yield* sql`CREATE INDEX IF NOT EXISTS idx_tx_out_consumed ON tx_out(consumed_by_tx_id)`
      .unprepared;

    // Redeemers
    yield* sql`
      CREATE TABLE IF NOT EXISTS redeemer (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_id INTEGER NOT NULL REFERENCES tx(id),
        unit_mem INTEGER NOT NULL,
        unit_steps INTEGER NOT NULL,
        fee INTEGER NOT NULL,
        purpose TEXT NOT NULL,
        "index" INTEGER NOT NULL,
        script_hash BLOB,
        datum_id INTEGER NOT NULL REFERENCES datum(id),
        UNIQUE(tx_id, purpose, "index")
      )
    `.unprepared;

    // Inputs
    yield* sql`
      CREATE TABLE IF NOT EXISTS tx_in (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_in_id INTEGER NOT NULL REFERENCES tx(id),
        tx_out_id INTEGER NOT NULL REFERENCES tx(id),
        tx_out_index INTEGER NOT NULL,
        redeemer_id INTEGER REFERENCES redeemer(id),
        UNIQUE(tx_out_id, tx_out_index)
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS collateral_tx_in (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_in_id INTEGER NOT NULL REFERENCES tx(id),
        tx_out_id INTEGER NOT NULL REFERENCES tx(id),
        tx_out_index INTEGER NOT NULL,
        UNIQUE(tx_in_id, tx_out_id, tx_out_index)
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS collateral_tx_out (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_id INTEGER NOT NULL REFERENCES tx(id),
        "index" INTEGER NOT NULL,
        address TEXT NOT NULL,
        address_raw BLOB NOT NULL,
        address_has_script INTEGER NOT NULL,
        payment_cred BLOB,
        stake_address_id INTEGER REFERENCES stake_address(id),
        value INTEGER NOT NULL,
        data_hash BLOB,
        multi_assets_descr TEXT NOT NULL,
        inline_datum_id INTEGER REFERENCES datum(id),
        reference_script_id INTEGER REFERENCES script(id)
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS reference_tx_in (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_in_id INTEGER NOT NULL REFERENCES tx(id),
        tx_out_id INTEGER NOT NULL REFERENCES tx(id),
        tx_out_index INTEGER NOT NULL
      )
    `.unprepared;

    // Multi-asset
    yield* sql`
      CREATE TABLE IF NOT EXISTS multi_asset (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        policy BLOB NOT NULL,
        name BLOB NOT NULL,
        fingerprint TEXT NOT NULL,
        UNIQUE(policy, name)
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS ma_tx_mint (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quantity INTEGER NOT NULL,
        tx_id INTEGER NOT NULL REFERENCES tx(id),
        ident INTEGER NOT NULL REFERENCES multi_asset(id),
        UNIQUE(ident, tx_id)
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS ma_tx_out (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quantity INTEGER NOT NULL,
        tx_out_id INTEGER NOT NULL REFERENCES tx_out(id),
        ident INTEGER NOT NULL REFERENCES multi_asset(id),
        UNIQUE(ident, tx_out_id)
      )
    `.unprepared;

    // Pools
    yield* sql`
      CREATE TABLE IF NOT EXISTS pool (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash_raw BLOB NOT NULL UNIQUE,
        view TEXT NOT NULL
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS pool_metadata_ref (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_id INTEGER NOT NULL REFERENCES pool(id),
        url TEXT NOT NULL,
        hash BLOB NOT NULL,
        registered_tx_id INTEGER NOT NULL REFERENCES tx(id)
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS pool_update (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash_id INTEGER NOT NULL REFERENCES pool(id),
        cert_index INTEGER NOT NULL,
        vrf_key_hash BLOB NOT NULL,
        pledge INTEGER NOT NULL,
        reward_addr BLOB NOT NULL,
        active_epoch_no INTEGER NOT NULL,
        meta_id INTEGER REFERENCES pool_metadata_ref(id),
        margin REAL NOT NULL,
        fixed_cost INTEGER NOT NULL,
        registered_tx_id INTEGER NOT NULL REFERENCES tx(id),
        deposit INTEGER,
        UNIQUE(hash_id, registered_tx_id)
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS pool_retire (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash_id INTEGER NOT NULL REFERENCES pool(id),
        cert_index INTEGER NOT NULL,
        announced_tx_id INTEGER NOT NULL REFERENCES tx(id),
        retiring_epoch INTEGER NOT NULL
      )
    `.unprepared;

    // Delegation
    yield* sql`
      CREATE TABLE IF NOT EXISTS stake_registration (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        addr_id INTEGER NOT NULL REFERENCES stake_address(id),
        cert_index INTEGER NOT NULL,
        epoch_no INTEGER NOT NULL,
        tx_id INTEGER NOT NULL REFERENCES tx(id),
        deposit INTEGER,
        UNIQUE(addr_id, tx_id)
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS stake_deregistration (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        addr_id INTEGER NOT NULL REFERENCES stake_address(id),
        cert_index INTEGER NOT NULL,
        epoch_no INTEGER NOT NULL,
        tx_id INTEGER NOT NULL REFERENCES tx(id),
        redeemer_id INTEGER REFERENCES redeemer(id),
        UNIQUE(addr_id, tx_id)
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS delegation (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        addr_id INTEGER NOT NULL REFERENCES stake_address(id),
        cert_index INTEGER NOT NULL,
        pool_hash_id INTEGER NOT NULL REFERENCES pool(id),
        active_epoch_no INTEGER NOT NULL,
        tx_id INTEGER NOT NULL REFERENCES tx(id),
        slot_no INTEGER NOT NULL,
        redeemer_id INTEGER REFERENCES redeemer(id)
      )
    `.unprepared;

    yield* sql`CREATE INDEX IF NOT EXISTS idx_delegation_addr ON delegation(addr_id)`.unprepared;
    yield* sql`CREATE INDEX IF NOT EXISTS idx_delegation_pool ON delegation(pool_hash_id)`
      .unprepared;

    // Epochs
    yield* sql`
      CREATE TABLE IF NOT EXISTS epoch (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        out_sum INTEGER NOT NULL,
        fees INTEGER NOT NULL,
        tx_count INTEGER NOT NULL,
        blk_count INTEGER NOT NULL,
        no INTEGER NOT NULL UNIQUE,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS epoch_stake (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        addr_id INTEGER NOT NULL REFERENCES stake_address(id),
        pool_id INTEGER NOT NULL REFERENCES pool(id),
        amount INTEGER NOT NULL,
        epoch_no INTEGER NOT NULL
      )
    `.unprepared;

    yield* sql`CREATE INDEX IF NOT EXISTS idx_epoch_stake_epoch ON epoch_stake(epoch_no)`.unprepared;
    yield* sql`CREATE INDEX IF NOT EXISTS idx_epoch_stake_pool ON epoch_stake(pool_id)`.unprepared;

    // Rewards
    yield* sql`
      CREATE TABLE IF NOT EXISTS reward (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        addr_id INTEGER NOT NULL REFERENCES stake_address(id),
        type TEXT NOT NULL,
        amount INTEGER NOT NULL,
        earned_epoch INTEGER NOT NULL,
        spendable_epoch INTEGER NOT NULL,
        pool_id INTEGER REFERENCES pool(id)
      )
    `.unprepared;

    yield* sql`CREATE INDEX IF NOT EXISTS idx_reward_addr ON reward(addr_id, earned_epoch)`
      .unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS withdrawal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        addr_id INTEGER NOT NULL REFERENCES stake_address(id),
        amount INTEGER NOT NULL,
        redeemer_id INTEGER REFERENCES redeemer(id),
        tx_id INTEGER NOT NULL REFERENCES tx(id),
        UNIQUE(addr_id, tx_id)
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS ada_pots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slot_no INTEGER NOT NULL,
        epoch_no INTEGER NOT NULL,
        treasury INTEGER NOT NULL,
        reserves INTEGER NOT NULL,
        rewards INTEGER NOT NULL,
        utxo INTEGER NOT NULL,
        deposits_stake INTEGER NOT NULL DEFAULT 0,
        deposits_drep INTEGER NOT NULL DEFAULT 0,
        deposits_proposal INTEGER NOT NULL DEFAULT 0,
        fees INTEGER NOT NULL,
        block_id INTEGER NOT NULL UNIQUE REFERENCES immutable_blocks(slot)
      )
    `.unprepared;

    // Governance (Conway)
    yield* sql`
      CREATE TABLE IF NOT EXISTS drep_hash (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        raw BLOB,
        view TEXT NOT NULL,
        has_script INTEGER NOT NULL,
        UNIQUE(raw, has_script)
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS voting_anchor (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        data_hash BLOB NOT NULL,
        type TEXT NOT NULL,
        block_id INTEGER NOT NULL REFERENCES immutable_blocks(slot),
        UNIQUE(data_hash, url, type)
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS gov_action_proposal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_id INTEGER NOT NULL REFERENCES tx(id),
        "index" INTEGER NOT NULL,
        prev_gov_action_proposal INTEGER,
        deposit INTEGER NOT NULL,
        return_address INTEGER NOT NULL REFERENCES stake_address(id),
        expiration INTEGER,
        voting_anchor_id INTEGER REFERENCES voting_anchor(id),
        type TEXT NOT NULL,
        description TEXT NOT NULL,
        param_proposal INTEGER,
        ratified_epoch INTEGER,
        enacted_epoch INTEGER,
        dropped_epoch INTEGER,
        expired_epoch INTEGER
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS committee_hash (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        raw BLOB NOT NULL,
        has_script INTEGER NOT NULL,
        UNIQUE(raw, has_script)
      )
    `.unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS voting_procedure (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_id INTEGER NOT NULL REFERENCES tx(id),
        "index" INTEGER NOT NULL,
        gov_action_proposal_id INTEGER NOT NULL REFERENCES gov_action_proposal(id),
        voter_role TEXT NOT NULL,
        committee_voter INTEGER REFERENCES committee_hash(id),
        drep_voter INTEGER REFERENCES drep_hash(id),
        pool_voter INTEGER REFERENCES pool(id),
        vote TEXT NOT NULL,
        voting_anchor_id INTEGER REFERENCES voting_anchor(id)
      )
    `.unprepared;

    yield* sql`CREATE INDEX IF NOT EXISTS idx_voting_procedure_gov ON voting_procedure(gov_action_proposal_id)`
      .unprepared;

    yield* sql`
      CREATE TABLE IF NOT EXISTS constitution (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gov_action_proposal_id INTEGER REFERENCES gov_action_proposal(id),
        voting_anchor_id INTEGER NOT NULL REFERENCES voting_anchor(id),
        script_hash BLOB
      )
    `.unprepared;

    // Metadata
    yield* sql`
      CREATE TABLE IF NOT EXISTS tx_metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key INTEGER NOT NULL,
        json TEXT,
        bytes BLOB NOT NULL,
        tx_id INTEGER NOT NULL REFERENCES tx(id),
        UNIQUE(key, tx_id)
      )
    `.unprepared;
  }),

  "0002_volatile_slot_index_and_default_slot_leader": Effect.gen(function* () {
    const sql = (yield* SqlClient).withoutTransforms();

    // Index on volatile_blocks(slot) — needed for getTip, garbageCollect, promoteBlocks
    yield* sql`CREATE INDEX IF NOT EXISTS idx_volatile_slot ON volatile_blocks(slot)`.unprepared;

    // Default slot_leader row — immutable_blocks.slot_leader_id FK references this
    yield* sql`
      INSERT OR IGNORE INTO slot_leader (id, hash, description) VALUES (0, X'00', 'unknown')
    `.unprepared;
  }),

  "0003_nonces_table": Effect.gen(function* () {
    const sql = (yield* SqlClient).withoutTransforms();

    yield* sql`
      CREATE TABLE IF NOT EXISTS nonces (
        epoch INTEGER PRIMARY KEY,
        active BLOB NOT NULL,
        evolving BLOB NOT NULL,
        candidate BLOB NOT NULL
      )
    `.unprepared;
  }),
});

const run = Migrator.make({});

/**
 * Run database migrations and PRAGMA setup.
 * Tracked by Effect's Migrator — each migration only runs once.
 */
export const runMigrations = Effect.gen(function* () {
  yield* pragmas;
  yield* run({ loader: migrations });
  yield* Effect.log("Storage migrations complete: full ChainDB schema created");
});
