/**
 * LsmAdmin — LSM-specific operations that don't fit the backend-agnostic
 * BlobStore interface (snapshot save/restore). Pairs with BlobStore from the
 * same layer so callers have one shared FFI handle across data + admin ops.
 */
import { Context, Effect, Schema } from "effect";

export class LsmAdminError extends Schema.TaggedErrorClass<LsmAdminError>()("LsmAdminError", {
  operation: Schema.String,
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
     * Use this to round-trip data through a snapshot within one session; use
     * `layerLsmFromSnapshot` to open a fresh session from a snapshot at
     * startup.
     * @param name Snapshot name
     * @param label Snapshot label (default: "UTxO table")
     */
    readonly openSnapshot: (name: string, label?: string) => Effect.Effect<void, LsmAdminError>;
  }
>()("ffi/LsmAdmin") {}
