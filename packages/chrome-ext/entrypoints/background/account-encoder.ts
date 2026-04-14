/**
 * Compact binary encoder for AccountState values written to IndexedDB.
 *
 * Layout (73 bytes fixed):
 *   [0..8)   balance         u64 BE (lovelace)
 *   [8..16)  deposit         u64 BE (lovelace)
 *   [16]     flags           u8
 *                              bit 0    : 1 if poolDelegation present
 *                              bits 1-3 : drep kind (0=none, 1=keyHash, 2=script,
 *                                                    3=alwaysAbstain, 4=alwaysNoConfidence)
 *   [17..45) poolHash        28B (all zero if absent)
 *   [45..73) drepHash        28B (all zero if kind is none/alwaysAbstain/alwaysNoConfidence)
 *
 * Fixed layout avoids variable-length overhead and matches the 28-byte credential
 * hash format used throughout the Cardano ledger state.
 */
import type { AccountState, StateDRep } from "ledger";

const EMPTY_HASH = new Uint8Array(28);

const drepKindCode = (kind: StateDRep["kind"] | undefined): number => {
  if (!kind) return 0;
  switch (kind) {
    case "keyHash":
      return 1;
    case "script":
      return 2;
    case "alwaysAbstain":
      return 3;
    case "alwaysNoConfidence":
      return 4;
  }
};

export const encodeAccountValue = (acct: AccountState): Uint8Array => {
  const buf = new Uint8Array(73);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(0, acct.balance, false);
  dv.setBigUint64(8, acct.deposit, false);

  const drepKind = drepKindCode(acct.drepDelegation?.kind);
  const hasPool = acct.poolDelegation ? 1 : 0;
  buf[16] = (hasPool & 0x01) | ((drepKind & 0x07) << 1);

  if (acct.poolDelegation) buf.set(acct.poolDelegation, 17);
  else buf.set(EMPTY_HASH, 17);

  if (acct.drepDelegation?.hash) buf.set(acct.drepDelegation.hash, 45);
  else buf.set(EMPTY_HASH, 45);

  return buf;
};
