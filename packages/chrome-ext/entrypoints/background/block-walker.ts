/**
 * Re-export block analysis from storage package.
 * The implementation lives in packages/storage/src/blob-store/block-analysis.ts
 * so it can be shared between chrome-ext (bootstrap) and consensus (relay sync).
 *
 * The chrome-ext MV3 background runs in a sync-oriented event loop (IndexedDB
 * callbacks, alarms, `onMessage` handlers), so we re-export the throwing
 * `analyzeBlockCborUnsafe` variant under the old name. Callers wrap in a
 * `try/catch` (see `bootstrap-sync.ts`) and filter by
 * `BlockAnalysisParseError`. Consumers on the Effect boundary
 * (`packages/consensus`, `packages/storage`) use the Effect-returning
 * primary `analyzeBlockCbor` directly.
 */
export {
  analyzeBlockCborUnsafe as analyzeBlockCbor,
  BlockAnalysis,
  BlockAnalysisParseError,
} from "storage";
