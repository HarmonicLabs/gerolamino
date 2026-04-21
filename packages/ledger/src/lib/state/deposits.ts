import { Schema } from "effect";
import { toCodecCbor, toCodecCborBytes } from "codecs";
import { StateCredential } from "../core/credentials.ts";
import { Bytes28 } from "../core/hashes.ts";
import { GovActionId } from "../governance/governance.ts";

// ────────────────────────────────────────────────────────────────────────────
// DepositPurpose — Conway §9.3 tagged union keying `UTxOState.deposits`
// (`HashMap<DepositPurpose, Coin>`). Five variants:
//
//   0: KeyDeposit       — stake-key registration deposit
//   1: PoolDeposit      — stake-pool registration deposit
//   2: DRepDeposit      — DRep registration deposit
//   3: GovActionDeposit — governance-action submission deposit (by GovActionId)
//   4: ProposalDeposit  — proposal-procedure deposit (by GovActionId)
//
// CBOR wire: `[UInt(tag), ...fields]`. Haskell ref:
// `eras/conway/impl/src/Cardano/Ledger/Conway/State/CertState.hs`
// `eras/shelley/impl/src/Cardano/Ledger/Shelley/LedgerState/Types.hs`.
// ────────────────────────────────────────────────────────────────────────────

export enum DepositPurposeKind {
  KeyDeposit = 0,
  PoolDeposit = 1,
  DRepDeposit = 2,
  GovActionDeposit = 3,
  ProposalDeposit = 4,
}

export const DepositPurpose = Schema.Union([
  Schema.TaggedStruct(DepositPurposeKind.KeyDeposit, { credential: StateCredential }),
  Schema.TaggedStruct(DepositPurposeKind.PoolDeposit, { keyHash: Bytes28 }),
  Schema.TaggedStruct(DepositPurposeKind.DRepDeposit, { credential: StateCredential }),
  Schema.TaggedStruct(DepositPurposeKind.GovActionDeposit, { govActionId: GovActionId }),
  Schema.TaggedStruct(DepositPurposeKind.ProposalDeposit, { govActionId: GovActionId }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type DepositPurpose = typeof DepositPurpose.Type;

export const DepositPurposeBytes = toCodecCborBytes(DepositPurpose);
export const DepositPurposeCbor = toCodecCbor(DepositPurpose);
