/**
 * OPFS platform layer for chrome-ext (Effect `FileSystem` + WASI bridge).
 *
 * @since 4.0.0
 */
export * as OpfsFileSystem from "./file-system.ts";
export * from "./ledger-ingest.ts";
export * from "./inspect.ts";
export { writeOpfsFileSlice } from "./file-system.ts";
export * from "./wasi-preopen.ts";
