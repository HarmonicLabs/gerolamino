/**
 * Re-export block analysis from storage package.
 * The implementation lives in packages/storage/src/blob-store/block-analysis.ts
 * so it can be shared between chrome-ext (bootstrap) and consensus (relay sync).
 */
export { analyzeBlockCbor } from "storage";
export type { BlockAnalysis } from "storage";
