/**
 * Cardano era enumeration and capability predicates.
 * The era number corresponds to the CBOR discriminant in block encoding: [era, blockData].
 */
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Era enum
// ---------------------------------------------------------------------------

export enum Era {
  Byron = 0,
  Shelley = 1,
  Allegra = 2,
  Mary = 3,
  Alonzo = 4,
  Babbage = 5,
  Conway = 6,
}

/** Schema.Enum validates input is one of Era's numeric values. */
export const EraSchema = Schema.Enum(Era);

// ---------------------------------------------------------------------------
// Era capability predicates (pipeline-friendly)
// ---------------------------------------------------------------------------

export const hasMultiAsset = (era: Era) => era >= Era.Mary;
export const hasDatumHash = (era: Era) => era >= Era.Alonzo;
export const hasInlineDatum = (era: Era) => era >= Era.Babbage;
export const hasRefScript = (era: Era) => era >= Era.Babbage;
export const hasGovernance = (era: Era) => era >= Era.Conway;
export const usesSetTag = (era: Era) => era >= Era.Conway;
