/**
 * Thin re-export. BlobStore + BlobStoreError live in `ffi` (the LSM FFI
 * backend is the source of truth); `storage` provides additional backends
 * (in-memory, block-analysis) over the same service.
 */
export { BlobStore, BlobStoreError, BlobEntry } from "ffi";
