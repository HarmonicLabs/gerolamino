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
import { Effect, Metric, Schema } from "effect";
import { parseSync, encodeSync, CborKinds, CborValue, type CborSchemaType } from "codecs";
import {
  type BlobEntry,
  BlobEntry as BlobEntrySchema,
  utxoKey,
  stakeKey,
  accountKey,
  analyzeBlockCbor,
} from "storage";
import { BlockAccepted } from "../observability.ts";

/**
 * Raised when `applyBlock` fails to derive a `BlockDiff` — either the
 * block's CBOR is malformed (wrapping a `BlockAnalysisParseError`) or
 * `parseSync` can't consume the body.
 */
export class ApplyBlockError extends Schema.TaggedErrorClass<ApplyBlockError>()("ApplyBlockError", {
  reason: Schema.String,
}) {}

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
// CBOR shape helpers — all guards consume `CborValue.guards[CborKinds.X]`
// predicates so the narrowed branch types thread through `parseSync` output
// without `!` / `as` assertions.
// ---------------------------------------------------------------------------

const EMPTY_28 = new Uint8Array(28);

/** Build 34-byte TxIn key: txId(32B) + index(2B big-endian). */
const buildTxInBytes = (txId: Uint8Array, index: number): Uint8Array => {
  const buf = new Uint8Array(34);
  buf.set(txId, 0);
  new DataView(buf.buffer).setUint16(32, index);
  return buf;
};

/** Unwrap Conway tag-258 set wrapping to get the inner array items.
 *  Accepts both `Array` (bare) and `Tag(258, Array)` (set-wrapped) — any
 *  other shape yields an empty view so callers can stay unconditional. */
const unwrapSet = (node: CborSchemaType): readonly CborSchemaType[] => {
  if (CborValue.guards[CborKinds.Array](node)) return node.items;
  if (
    CborValue.guards[CborKinds.Tag](node) &&
    node.tag === 258n &&
    CborValue.guards[CborKinds.Array](node.data)
  ) {
    return node.data.items;
  }
  return [];
};

/** Look up an integer key in a CBOR map — linear scan (maps are small;
 *  tx body ≤ 20 keys). Returns the value node or `undefined`. */
const mapGet = (
  entries: readonly { readonly k: CborSchemaType; readonly v: CborSchemaType }[],
  key: number,
): CborSchemaType | undefined =>
  entries.find((e) => CborValue.guards[CborKinds.UInt](e.k) && Number(e.k.num) === key)?.v;

/** Extract 28-byte credential hash from CBOR credential node `[kind, hash28]`. */
const credentialHash = (node: CborSchemaType | undefined): Uint8Array | undefined => {
  if (node === undefined || !CborValue.guards[CborKinds.Array](node) || node.items.length < 2) {
    return undefined;
  }
  const h = node.items[1];
  return h !== undefined && CborValue.guards[CborKinds.Bytes](h) && h.bytes.byteLength === 28
    ? h.bytes
    : undefined;
};

/**
 * Extract DRep info from CBOR drep node.
 * Returns flags bits (for bits 1-3 of account flags) and 28-byte hash.
 *   DRep encoding: [0, keyhash] | [1, scripthash] | [2] | [3]
 *   kind mapping: 0→keyHash(1), 1→script(2), 2→alwaysAbstain(3), 3→alwaysNoConfidence(4)
 */
type DRep = { readonly kind: number; readonly hash: Uint8Array };
const NO_DREP: DRep = { kind: 0, hash: EMPTY_28 };

const drepHashOrEmpty = (node: CborSchemaType | undefined): Uint8Array =>
  node !== undefined && CborValue.guards[CborKinds.Bytes](node) ? node.bytes : EMPTY_28;

const extractDRep = (node: CborSchemaType | undefined): DRep => {
  if (node === undefined || !CborValue.guards[CborKinds.Array](node) || node.items.length < 1) {
    return NO_DREP;
  }
  const tag = node.items[0];
  if (tag === undefined || !CborValue.guards[CborKinds.UInt](tag)) return NO_DREP;
  switch (Number(tag.num)) {
    case 0:
      return { kind: 1, hash: drepHashOrEmpty(node.items[1]) };
    case 1:
      return { kind: 2, hash: drepHashOrEmpty(node.items[1]) };
    case 2:
      return { kind: 3, hash: EMPTY_28 };
    case 3:
      return { kind: 4, hash: EMPTY_28 };
    default:
      return NO_DREP;
  }
};

/** Narrow to 28-byte bytes — used for pool/operator keys that require
 *  exact size to be valid Cardano hashes. */
const bytes28 = (node: CborSchemaType | undefined): Uint8Array | undefined =>
  node !== undefined && CborValue.guards[CborKinds.Bytes](node) && node.bytes.byteLength === 28
    ? node.bytes
    : undefined;

/** Narrow to UInt number — used for CBOR-encoded deposits / counters. */
const uint = (node: CborSchemaType | undefined): bigint | undefined =>
  node !== undefined && CborValue.guards[CborKinds.UInt](node) ? node.num : undefined;

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

/** Extract UTxO keys to delete from a CBOR inputs node (key 0 or key 13).
 *  `out` is passed by reference — multi-accumulator imperative hot-path;
 *  pulling it into `.map().filter().flatMap()` costs an extra allocation
 *  per-tx across 5 parallel accumulators (see `applyBlockCore`). */
const collectInputDeletes = (
  inputsNode: CborSchemaType | undefined,
  out: Array<Uint8Array>,
): void => {
  if (inputsNode === undefined) return;
  for (const item of unwrapSet(inputsNode)) {
    if (!CborValue.guards[CborKinds.Array](item) || item.items.length < 2) continue;
    const [txIdNode, idxNode] = item.items;
    if (
      txIdNode === undefined ||
      idxNode === undefined ||
      !CborValue.guards[CborKinds.Bytes](txIdNode) ||
      !CborValue.guards[CborKinds.UInt](idxNode)
    ) {
      continue;
    }
    out.push(utxoKey(buildTxInBytes(txIdNode.bytes, Number(idxNode.num))));
  }
};

/** Extract UTxO entries to insert from a CBOR outputs node (key 1). */
const collectOutputInserts = (
  outputsNode: CborSchemaType | undefined,
  txId: Uint8Array,
  out: Array<BlobEntry>,
): void => {
  if (outputsNode === undefined || !CborValue.guards[CborKinds.Array](outputsNode)) return;
  // `.forEach((item, j)` is equivalent to `for (let j = 0; ...)` here and
  // avoids re-deriving the item from items[j]. Same allocation profile.
  outputsNode.items.forEach((item, j) => {
    out.push({ key: utxoKey(buildTxInBytes(txId, j)), value: encodeSync(item) });
  });
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
  if (certsNode === undefined) return;
  for (const cert of unwrapSet(certsNode)) {
    if (!CborValue.guards[CborKinds.Array](cert) || cert.items.length < 2) continue;
    const tagNode = cert.items[0];
    if (tagNode === undefined || !CborValue.guards[CborKinds.UInt](tagNode)) continue;
    const tag = Number(tagNode.num);

    switch (tag) {
      // --- Registration (create account with zero balance) ---
      case 0: // StakeRegistration [0, credential]
      case 7: {
        // RegDeposit [7, credential, deposit]
        const h = credentialHash(cert.items[1]);
        if (h === undefined) break;
        const deposit = (tag === 7 && uint(cert.items[2])) || 0n;
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
        if (h !== undefined) accountDeletes.push(accountKey(h));
        break;
      }

      // --- Pool delegation only ---
      case 2: {
        // StakeDelegation [2, credential, poolKeyHash]
        const h = credentialHash(cert.items[1]);
        const pool = bytes28(cert.items[2]);
        if (h === undefined || pool === undefined) break;
        accountUpdates.push({
          key: accountKey(h),
          value: encodeAccountValue(0n, 0n, 1, pool, EMPTY_28),
        });
        break;
      }

      // --- Pool registration ---
      case 3: {
        // PoolRegistration [3, operator, vrfKeyhash, pledge, cost, margin, rewardAcct, ...]
        const operator = bytes28(cert.items[1]);
        if (operator !== undefined) {
          stakeUpdates.push({ key: stakeKey(operator), value: encodeStakeValue(0n) });
        }
        break;
      }

      // Pool retirement (tag 4): deferred to epoch boundary — no immediate state change.

      // --- DRep delegation only ---
      case 9: {
        // VoteDeleg [9, credential, drep]
        const h = credentialHash(cert.items[1]);
        if (h === undefined) break;
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
        const pool = bytes28(cert.items[2]);
        if (h === undefined || pool === undefined) break;
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
        const pool = bytes28(cert.items[2]);
        const deposit = uint(cert.items[3]) ?? 0n;
        if (h === undefined || pool === undefined) break;
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
        const deposit = uint(cert.items[3]) ?? 0n;
        if (h === undefined) break;
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
        const pool = bytes28(cert.items[2]);
        const deposit = uint(cert.items[4]) ?? 0n;
        if (h === undefined || pool === undefined) break;
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
/**
 * Pure, synchronous core of `applyBlock` — throws on malformed CBOR / AST
 * mismatches. Split out so the entry-point wrapper can funnel the throw
 * through `Effect.try` and return a typed `Effect<BlockDiff, ApplyBlockError>`.
 */
const applyBlockCore = (
  analysis: { readonly blockNo: bigint; readonly txOffsets: ReadonlyArray<unknown> },
  blockCbor: Uint8Array,
  txIds: readonly Uint8Array[],
): BlockDiff => {
  if (analysis.blockNo === 0n || analysis.txOffsets.length === 0) return EMPTY_DIFF;

  // Parse full block CBOR AST.
  const root = parseSync(blockCbor);
  if (!CborValue.guards[CborKinds.Array](root) || root.items.length < 2) return EMPTY_DIFF;

  const eraTag = root.items[0];
  if (eraTag === undefined || !CborValue.guards[CborKinds.UInt](eraTag) || eraTag.num <= 1n) {
    return EMPTY_DIFF;
  }

  const blockBody = root.items[1];
  if (
    blockBody === undefined ||
    !CborValue.guards[CborKinds.Array](blockBody) ||
    blockBody.items.length < 2
  ) {
    return EMPTY_DIFF;
  }

  const txBodiesNode = blockBody.items[1];
  if (txBodiesNode === undefined || !CborValue.guards[CborKinds.Array](txBodiesNode)) {
    return EMPTY_DIFF;
  }

  // Invalid-tx indices (Alonzo+, block body element at index 4). A tx is
  // valid iff its index is NOT in this set. `.flatMap(filterMap)` is the
  // standard TS functional-filter idiom: keep guard-matching items, drop
  // the rest, all without a mutable accumulator.
  const invalidTxIndices = new Set<number>(
    blockBody.items.length >= 5 && blockBody.items[4] !== undefined
      ? unwrapSet(blockBody.items[4]).flatMap((item) =>
          CborValue.guards[CborKinds.UInt](item) ? [Number(item.num)] : [],
        )
      : [],
  );

  // Five parallel accumulators — pre-allocated here so the nested helpers
  // (`collectInputDeletes`, `collectOutputInserts`, `processCerts`) push
  // directly. Structurally imperative (multi-out dispatch pattern); the
  // functional alternative of per-tx partial diffs + merge is O(n²) over
  // tx count, which a mainnet block with 300+ txs would feel.
  const utxoInserts: Array<BlobEntry> = [];
  const utxoDeletes: Array<Uint8Array> = [];
  const accountUpdates: Array<BlobEntry> = [];
  const accountDeletes: Array<Uint8Array> = [];
  const stakeUpdates: Array<BlobEntry> = [];

  const txCount = Math.min(txBodiesNode.items.length, analysis.txOffsets.length, txIds.length);

  for (let i = 0; i < txCount; i++) {
    const txBodyNode = txBodiesNode.items[i];
    if (txBodyNode === undefined || !CborValue.guards[CborKinds.Map](txBodyNode)) continue;

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
      if (collReturn !== undefined) {
        const outputsNode = mapGet(entries, 1);
        const outputCount =
          outputsNode !== undefined && CborValue.guards[CborKinds.Array](outputsNode)
            ? outputsNode.items.length
            : 0;
        utxoInserts.push({
          key: utxoKey(buildTxInBytes(txId, outputCount)),
          value: encodeSync(collReturn),
        });
      }
    }
  }

  return { utxoInserts, utxoDeletes, accountUpdates, accountDeletes, stakeUpdates };
};

/**
 * Effect-native `applyBlock`. Returns `EMPTY_DIFF` for shape-mismatched but
 * well-formed CBOR (Byron, outer-array-too-short, wrong tag); fails with a
 * typed `ApplyBlockError` only when the CBOR itself is malformed (wraps
 * the underlying `BlockAnalysisParseError`). Pre-refactor, both cases
 * collapsed to a silent `EMPTY_DIFF`, masking parser bugs.
 */
export const applyBlock = (
  blockCbor: Uint8Array,
  txIds: readonly Uint8Array[],
): Effect.Effect<BlockDiff, ApplyBlockError> =>
  analyzeBlockCbor(blockCbor).pipe(
    Effect.mapError(
      (cause) =>
        new ApplyBlockError({
          reason: `block-analysis failed: ${cause.reason} @${cause.pos}`,
        }),
    ),
    Effect.flatMap((analysis) =>
      Effect.try({
        try: () => applyBlockCore(analysis, blockCbor, txIds),
        catch: (cause) =>
          new ApplyBlockError({
            reason: `apply-block core failed: ${String(cause)}`,
          }),
      }),
    ),
    Effect.tap(() => Metric.update(BlockAccepted, 1)),
  );
