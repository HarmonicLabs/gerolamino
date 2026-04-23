/**
 * Block application — incremental ledger state transitions for UTxO, accounts, and stake.
 *
 * Processes a full block CBOR and produces a diff of storage entries to write/delete.
 * Does NOT run Plutus scripts or validate balances — purely tracks state transitions
 * that a non-validating observer needs:
 *
 * 1. UTxO set: consume inputs (delete), produce outputs (insert)
 * 2. Accounts: registration (create), deregistration (delete), delegation (update)
 * 3. Stake pools: registration (create/update)
 *
 * For invalid (Phase-2 failed) transactions: only collateral inputs are consumed
 * and collateral return outputs are produced (Alonzo+/Babbage+ respectively).
 *
 * References:
 *   - Shelley spec UTXOS rule (line 1866): utxo' = (utxo ⊳ txins^c) ∪l outs(txb)
 *   - Shelley spec DELEG rule (lines 2641-2663): rewards/voteDelegs/stakeDelegs maps
 *   - Conway CDDL: certificate tags 0-18, tag 258 set wrapping
 *   - Haskell: Cardano.Ledger.Shelley.Rules.Utxos, Cardano.Ledger.State.CertState
 */
import { Schema } from "effect";
import { parseSync, encodeSync, CborKinds, type CborSchemaType } from "codecs";
import { type BlobEntry, BlobEntry as BlobEntrySchema, utxoKey, stakeKey, accountKey, analyzeBlockCbor } from "storage";

// ---------------------------------------------------------------------------
// BlockDiff — the result of applying a block to the ledger state
// ---------------------------------------------------------------------------

export const BlockDiff = Schema.Struct({
  /** UTxO entries to add: key = utxoKey(txId || idx), value = CBOR-encoded TxOut */
  utxoInserts: Schema.Array(BlobEntrySchema),
  /** UTxO keys to delete (consumed inputs) */
  utxoDeletes: Schema.Array(Schema.Uint8Array),
  /** Account entries to create or update (registration + delegation info) */
  accountUpdates: Schema.Array(BlobEntrySchema),
  /** Account keys to delete (deregistration) */
  accountDeletes: Schema.Array(Schema.Uint8Array),
  /** Stake pool entries to create or update */
  stakeUpdates: Schema.Array(BlobEntrySchema),
});
export type BlockDiff = typeof BlockDiff.Type;

const EMPTY_DIFF: BlockDiff = {
  utxoInserts: [],
  utxoDeletes: [],
  accountUpdates: [],
  accountDeletes: [],
  stakeUpdates: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_28 = new Uint8Array(28);

/** Build 34-byte TxIn key: txId(32B) + index(2B big-endian). */
const buildTxInBytes = (txId: Uint8Array, index: number): Uint8Array => {
  const buf = new Uint8Array(34);
  buf.set(txId, 0);
  new DataView(buf.buffer).setUint16(32, index);
  return buf;
};

/** Unwrap Conway tag-258 set wrapping to get the inner array items. */
const unwrapSet = (node: CborSchemaType): readonly CborSchemaType[] => {
  if (node._tag === CborKinds.Array) return node.items;
  if (node._tag === CborKinds.Tag && node.tag === 258n && node.data._tag === CborKinds.Array) {
    return node.data.items;
  }
  return [];
};

/** Look up an integer key in a CBOR map. */
const mapGet = (
  entries: readonly { readonly k: CborSchemaType; readonly v: CborSchemaType }[],
  key: number,
): CborSchemaType | undefined => {
  for (const e of entries) {
    if (e.k._tag === CborKinds.UInt && Number(e.k.num) === key) return e.v;
  }
  return undefined;
};

/** Extract 28-byte credential hash from CBOR credential node [kind, hash28]. */
const credentialHash = (node: CborSchemaType | undefined): Uint8Array | undefined => {
  if (!node || node._tag !== CborKinds.Array || node.items.length < 2) return undefined;
  const h = node.items[1];
  if (h?._tag === CborKinds.Bytes && h.bytes.byteLength === 28) return h.bytes;
  return undefined;
};

/**
 * Extract DRep info from CBOR drep node.
 * Returns flags bits (for bits 1-3 of account flags) and 28-byte hash.
 *   DRep encoding: [0, keyhash] | [1, scripthash] | [2] | [3]
 *   kind mapping: 0→keyHash(1), 1→script(2), 2→alwaysAbstain(3), 3→alwaysNoConfidence(4)
 */
const extractDRep = (node: CborSchemaType | undefined): { kind: number; hash: Uint8Array } => {
  const none = { kind: 0, hash: EMPTY_28 };
  if (!node || node._tag !== CborKinds.Array || node.items.length < 1) return none;
  const tag = node.items[0];
  if (tag?._tag !== CborKinds.UInt) return none;
  switch (Number(tag.num)) {
    case 0:
      return {
        kind: 1,
        hash: node.items[1]?._tag === CborKinds.Bytes ? node.items[1].bytes : EMPTY_28,
      };
    case 1:
      return {
        kind: 2,
        hash: node.items[1]?._tag === CborKinds.Bytes ? node.items[1].bytes : EMPTY_28,
      };
    case 2:
      return { kind: 3, hash: EMPTY_28 };
    case 3:
      return { kind: 4, hash: EMPTY_28 };
    default:
      return none;
  }
};

/**
 * Encode a 73-byte account value matching the bootstrap format.
 *
 *   [0..8)   balance      u64 BE
 *   [8..16)  deposit      u64 BE
 *   [16]     flags        u8 (bit 0 = pool present, bits 1-3 = drep kind)
 *   [17..45) poolHash     28B
 *   [45..73) drepHash     28B
 */
const encodeAccountValue = (
  balance: bigint,
  deposit: bigint,
  flags: number,
  poolHash: Uint8Array,
  drepHash: Uint8Array,
): Uint8Array => {
  const buf = new Uint8Array(73);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(0, balance, false);
  dv.setBigUint64(8, deposit, false);
  buf[16] = flags & 0xff;
  buf.set(poolHash.subarray(0, 28), 17);
  buf.set(drepHash.subarray(0, 28), 45);
  return buf;
};

/** Encode 8-byte stake value (pool total stake in lovelace, u64 BE). */
const encodeStakeValue = (stake: bigint): Uint8Array => {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, stake, false);
  return buf;
};

// ---------------------------------------------------------------------------
// Input / Output extraction
// ---------------------------------------------------------------------------

/** Extract UTxO keys to delete from a CBOR inputs node (key 0 or key 13). */
const collectInputDeletes = (
  inputsNode: CborSchemaType | undefined,
  out: Array<Uint8Array>,
): void => {
  if (!inputsNode) return;
  for (const item of unwrapSet(inputsNode)) {
    if (item._tag !== CborKinds.Array || item.items.length < 2) continue;
    const txIdNode = item.items[0];
    const idxNode = item.items[1];
    if (txIdNode?._tag !== CborKinds.Bytes || idxNode?._tag !== CborKinds.UInt) continue;
    out.push(utxoKey(buildTxInBytes(txIdNode.bytes, Number(idxNode.num))));
  }
};

/** Extract UTxO entries to insert from a CBOR outputs node (key 1). */
const collectOutputInserts = (
  outputsNode: CborSchemaType | undefined,
  txId: Uint8Array,
  out: Array<BlobEntry>,
): void => {
  if (!outputsNode || outputsNode._tag !== CborKinds.Array) return;
  for (let j = 0; j < outputsNode.items.length; j++) {
    out.push({
      key: utxoKey(buildTxInBytes(txId, j)),
      value: encodeSync(outputsNode.items[j]!),
    });
  }
};

// ---------------------------------------------------------------------------
// Certificate processing
// ---------------------------------------------------------------------------

const processCerts = (
  certsNode: CborSchemaType | undefined,
  accountUpdates: Array<BlobEntry>,
  accountDeletes: Array<Uint8Array>,
  stakeUpdates: Array<BlobEntry>,
): void => {
  if (!certsNode) return;
  for (const cert of unwrapSet(certsNode)) {
    if (cert._tag !== CborKinds.Array || cert.items.length < 2) continue;
    const tagNode = cert.items[0];
    if (tagNode?._tag !== CborKinds.UInt) continue;
    const tag = Number(tagNode.num);

    switch (tag) {
      // --- Registration (create account with zero balance) ---
      case 0: // StakeRegistration [0, credential]
      case 7: {
        // RegDeposit [7, credential, deposit]
        const h = credentialHash(cert.items[1]);
        if (!h) break;
        const deposit =
          tag === 7 && cert.items[2]?._tag === CborKinds.UInt ? cert.items[2].num : 0n;
        accountUpdates.push({
          key: accountKey(h),
          value: encodeAccountValue(0n, deposit, 0, EMPTY_28, EMPTY_28),
        });
        break;
      }

      // --- Deregistration (delete account) ---
      case 1: // StakeDeregistration [1, credential]
      case 8: {
        // UnregDeposit [8, credential, deposit]
        const h = credentialHash(cert.items[1]);
        if (h) accountDeletes.push(accountKey(h));
        break;
      }

      // --- Pool delegation only ---
      case 2: {
        // StakeDelegation [2, credential, poolKeyHash]
        const h = credentialHash(cert.items[1]);
        const pool = cert.items[2]?._tag === CborKinds.Bytes ? cert.items[2].bytes : undefined;
        if (!h || !pool) break;
        accountUpdates.push({
          key: accountKey(h),
          value: encodeAccountValue(0n, 0n, 1, pool, EMPTY_28),
        });
        break;
      }

      // --- Pool registration ---
      case 3: {
        // PoolRegistration [3, operator, vrfKeyhash, pledge, cost, margin, rewardAcct, ...]
        const operator = cert.items[1]?._tag === CborKinds.Bytes ? cert.items[1].bytes : undefined;
        if (operator && operator.byteLength === 28) {
          stakeUpdates.push({ key: stakeKey(operator), value: encodeStakeValue(0n) });
        }
        break;
      }

      // Pool retirement (tag 4): deferred to epoch boundary — no immediate state change.

      // --- DRep delegation only ---
      case 9: {
        // VoteDeleg [9, credential, drep]
        const h = credentialHash(cert.items[1]);
        if (!h) break;
        const drep = extractDRep(cert.items[2]);
        accountUpdates.push({
          key: accountKey(h),
          value: encodeAccountValue(0n, 0n, drep.kind << 1, EMPTY_28, drep.hash),
        });
        break;
      }

      // --- Pool + DRep delegation ---
      case 10: {
        // StakeVoteDeleg [10, credential, poolKeyHash, drep]
        const h = credentialHash(cert.items[1]);
        const pool = cert.items[2]?._tag === CborKinds.Bytes ? cert.items[2].bytes : undefined;
        if (!h || !pool) break;
        const drep = extractDRep(cert.items[3]);
        accountUpdates.push({
          key: accountKey(h),
          value: encodeAccountValue(0n, 0n, 1 | (drep.kind << 1), pool, drep.hash),
        });
        break;
      }

      // --- Registration + pool delegation ---
      case 11: {
        // StakeRegDeleg [11, credential, poolKeyHash, deposit]
        const h = credentialHash(cert.items[1]);
        const pool = cert.items[2]?._tag === CborKinds.Bytes ? cert.items[2].bytes : undefined;
        const deposit = cert.items[3]?._tag === CborKinds.UInt ? cert.items[3].num : 0n;
        if (!h || !pool) break;
        accountUpdates.push({
          key: accountKey(h),
          value: encodeAccountValue(0n, deposit, 1, pool, EMPTY_28),
        });
        break;
      }

      // --- Registration + DRep delegation ---
      case 12: {
        // VoteRegDeleg [12, credential, drep, deposit]
        const h = credentialHash(cert.items[1]);
        const deposit = cert.items[3]?._tag === CborKinds.UInt ? cert.items[3].num : 0n;
        if (!h) break;
        const drep = extractDRep(cert.items[2]);
        accountUpdates.push({
          key: accountKey(h),
          value: encodeAccountValue(0n, deposit, drep.kind << 1, EMPTY_28, drep.hash),
        });
        break;
      }

      // --- Registration + pool + DRep delegation ---
      case 13: {
        // StakeVoteRegDeleg [13, credential, poolKeyHash, drep, deposit]
        const h = credentialHash(cert.items[1]);
        const pool = cert.items[2]?._tag === CborKinds.Bytes ? cert.items[2].bytes : undefined;
        const deposit = cert.items[4]?._tag === CborKinds.UInt ? cert.items[4].num : 0n;
        if (!h || !pool) break;
        const drep = extractDRep(cert.items[3]);
        accountUpdates.push({
          key: accountKey(h),
          value: encodeAccountValue(0n, deposit, 1 | (drep.kind << 1), pool, drep.hash),
        });
        break;
      }

      // Tags 4 (PoolRetirement), 5 (GenesisKeyDelegation), 6 (MoveInstantRewards),
      // 14-18 (committee/drep governance): no account/stake table changes needed.
    }
  }
};

// ---------------------------------------------------------------------------
// Main: applyBlock
// ---------------------------------------------------------------------------

/**
 * Apply a full block CBOR to produce a storage diff.
 *
 * Parses the block, iterates over transactions, and for each:
 * - Valid tx: delete consumed inputs, add produced outputs, process certs
 * - Invalid tx: delete collateral inputs, add collateral return (Babbage+)
 *
 * Callers must pre-compute tx ids (blake2b-256 of each tx body CBOR slice) via
 * their `Crypto` service and pass them in parallel to `analyzeBlockCbor(blockCbor).txOffsets`.
 * Keeping the hash work outside this function keeps the ledger-application
 * logic pure and synchronous while still letting the surrounding pipeline
 * route hashing through a worker-backed `Crypto` layer.
 *
 * @param blockCbor Full block CBOR bytes (not header-only)
 * @param txIds Pre-computed tx ids, in the same order as `analyzeBlockCbor(blockCbor).txOffsets`
 * @returns Storage diff to apply via ChainDB.writeBlobEntries / deleteBlobEntries
 */
export const applyBlock = (blockCbor: Uint8Array, txIds: readonly Uint8Array[]): BlockDiff => {
  try {
    // Use analyzeBlockCbor for tx body byte offsets (needed for txId ordering)
    const analysis = analyzeBlockCbor(blockCbor);
    if (analysis.blockNo === 0n || analysis.txOffsets.length === 0) return EMPTY_DIFF;

    // Parse full block CBOR AST
    const root = parseSync(blockCbor);
    if (root._tag !== CborKinds.Array || root.items.length < 2) return EMPTY_DIFF;

    const eraTag = root.items[0];
    if (eraTag?._tag !== CborKinds.UInt || eraTag.num <= 1n) return EMPTY_DIFF;

    const blockBody = root.items[1];
    if (blockBody?._tag !== CborKinds.Array || blockBody.items.length < 2) return EMPTY_DIFF;

    const txBodiesNode = blockBody.items[1];
    if (txBodiesNode?._tag !== CborKinds.Array) return EMPTY_DIFF;

    // Extract invalid tx indices (Alonzo+, block body element at index 4).
    // A tx is valid iff its index is NOT in this set.
    const invalidTxIndices = new Set<number>();
    if (blockBody.items.length >= 5) {
      const invalidNode = blockBody.items[4];
      if (invalidNode) {
        for (const item of unwrapSet(invalidNode)) {
          if (item._tag === CborKinds.UInt) invalidTxIndices.add(Number(item.num));
        }
      }
    }

    const utxoInserts: Array<BlobEntry> = [];
    const utxoDeletes: Array<Uint8Array> = [];
    const accountUpdates: Array<BlobEntry> = [];
    const accountDeletes: Array<Uint8Array> = [];
    const stakeUpdates: Array<BlobEntry> = [];

    const txCount = Math.min(txBodiesNode.items.length, analysis.txOffsets.length, txIds.length);

    for (let i = 0; i < txCount; i++) {
      const txBodyNode = txBodiesNode.items[i];
      if (!txBodyNode || txBodyNode._tag !== CborKinds.Map) continue;

      const txId = txIds[i]!;

      const entries = txBodyNode.entries;
      const isValid = !invalidTxIndices.has(i);

      if (isValid) {
        // UTXOS rule for valid tx:
        //   utxo' = (utxo ⊳ txins^c) ∪l outs(txb)
        collectInputDeletes(mapGet(entries, 0), utxoDeletes); // key 0: inputs
        collectOutputInserts(mapGet(entries, 1), txId, utxoInserts); // key 1: outputs
        processCerts(mapGet(entries, 4), accountUpdates, accountDeletes, stakeUpdates); // key 4: certs
        // key 5 (withdrawals): only affects reward balance which we don't track incrementally
      } else {
        // UTXOS rule for invalid (Phase-2 failed) tx:
        //   utxo' = (utxo ⊳ collateral^c) ∪l colReturnUTxO
        collectInputDeletes(mapGet(entries, 13), utxoDeletes); // key 13: collateral inputs

        // Collateral return (Babbage+, key 16): indexed at len(txOuts)
        const collReturn = mapGet(entries, 16);
        if (collReturn) {
          const outputsNode = mapGet(entries, 1);
          const outputCount = outputsNode?._tag === CborKinds.Array ? outputsNode.items.length : 0;
          utxoInserts.push({
            key: utxoKey(buildTxInBytes(txId, outputCount)),
            value: encodeSync(collReturn),
          });
        }
      }
    }

    return { utxoInserts, utxoDeletes, accountUpdates, accountDeletes, stakeUpdates };
  } catch {
    return EMPTY_DIFF;
  }
};
