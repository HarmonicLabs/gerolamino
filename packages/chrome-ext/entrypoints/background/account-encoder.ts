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
import { DRep, DRepKind } from "ledger";

const EMPTY_HASH = new Uint8Array(28);

const drepKindCode = (drep: StateDRep | undefined): number =>
  drep === undefined
    ? 0
    : DRep.match(drep, {
        [DRepKind.KeyHash]: () => 1,
        [DRepKind.Script]: () => 2,
        [DRepKind.AlwaysAbstain]: () => 3,
        [DRepKind.AlwaysNoConfidence]: () => 4,
      });

const drepHash = (drep: StateDRep | undefined): Uint8Array | undefined =>
  drep !== undefined && DRep.isAnyOf([DRepKind.KeyHash, DRepKind.Script])(drep)
    ? drep.hash
    : undefined;

export const encodeAccountValue = (acct: AccountState): Uint8Array => {
  const buf = new Uint8Array(73);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(0, acct.balance, false);
  dv.setBigUint64(8, acct.deposit, false);

  const drepKind = drepKindCode(acct.drepDelegation);
  const hasPool = acct.poolDelegation ? 1 : 0;
  buf[16] = (hasPool & 0x01) | ((drepKind & 0x07) << 1);

  if (acct.poolDelegation) buf.set(acct.poolDelegation, 17);
  else buf.set(EMPTY_HASH, 17);

  const hash = drepHash(acct.drepDelegation);
  if (hash) buf.set(hash, 45);
  else buf.set(EMPTY_HASH, 45);

  return buf;
};
