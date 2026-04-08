/**
 * Cardano era enumeration and capability predicates.
 * The era number corresponds to the CBOR discriminant in block encoding: [era, blockData].
 * Wire format: 0-1 = Byron (EBB / main), 2 = Shelley, 3 = Allegra, ..., 7 = Conway.
 */
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Era enum — values match wire format era tags
// ---------------------------------------------------------------------------

export enum Era {
  Byron = 0,
  Shelley = 2,
  Allegra = 3,
  Mary = 4,
  Alonzo = 5,
  Babbage = 6,
  Conway = 7,
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
