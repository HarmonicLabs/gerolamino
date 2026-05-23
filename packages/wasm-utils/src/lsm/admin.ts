/**
 * LsmAdmin — LSM-specific operations that don't fit the backend-agnostic
 * BlobStore interface (snapshot save/restore). Pairs with BlobStore from the
 * same layer so callers have one shared WASM handle across data + admin ops.
 */
import { Context, Effect, Schema } from "effect";

export const LsmAdminOperation = Schema.Literals(["snapshot", "openSnapshot"]);
export type LsmAdminOperation = typeof LsmAdminOperation.Type;

export class LsmAdminError extends Schema.TaggedErrorClass<LsmAdminError>()("LsmAdminError", {
  operation: LsmAdminOperation,
  cause: Schema.Defect,
}) {}

export class LsmAdmin extends Context.Service<
  LsmAdmin,
  {
    /**
     * Save the current LSM state as a named snapshot.
     * @param name Snapshot name (becomes `<name>` under `$session/snapshots/`)
     * @param label Snapshot label (default: "UTxO table" for cardano-node compatibility)
     */
    readonly snapshot: (name: string, label?: string) => Effect.Effect<void, LsmAdminError>;
    /**
     * Swap the current table for one restored from a named snapshot in the
     * current session. Session stays open — only the table handle changes.
     */
    readonly openSnapshot: (name: string, label?: string) => Effect.Effect<void, LsmAdminError>;
  }
>()("ffi/LsmAdmin") {}
