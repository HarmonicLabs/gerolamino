/**
 * LedgerStateSnapshot — serialized ledger state for persistence.
 *
 * The state is stored as opaque bytes (CBOR or MemPack).
 * The consensus layer decodes it into ExtLedgerState using the ledger package.
 */
import { Schema } from "effect";
import { RealPoint } from "./StoredBlock.ts";

export const LedgerStateSnapshot = Schema.Struct({
  point: RealPoint,
  stateBytes: Schema.Uint8Array,
  epoch: Schema.BigInt,
  slot: Schema.BigInt,
});
export type LedgerStateSnapshot = typeof LedgerStateSnapshot.Type;
