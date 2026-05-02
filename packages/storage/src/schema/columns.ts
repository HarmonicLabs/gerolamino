/**
 * Shared custom column types.
 *
 * `bytes` — BLOB column that round-trips raw `Uint8Array` (not Node
 * `Buffer`). The Effect SqlClient adapters (`@effect/sql-sqlite-bun`,
 * `@effect/sql-sqlite-wasm`) return BLOB columns as `Uint8Array` at
 * runtime, and the rest of the codebase (codecs, crypto, BlobStore)
 * works in `Uint8Array` throughout. Drizzle's stock
 * `blob({ mode: "buffer" })` types as `Buffer<ArrayBufferLike>`, which
 * is a subclass of `Uint8Array` but not assignable in the contravariant
 * direction — so anywhere the schema expects a write of bytes, you'd
 * have to wrap every value in `Buffer.from(...)`. `bytes` types as
 * plain `Uint8Array` and lets values flow through unchanged.
 */
import { customType } from "drizzle-orm/sqlite-core";

export const bytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "blob",
});
