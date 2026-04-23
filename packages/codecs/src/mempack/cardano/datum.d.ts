import type { DecodedInlineDatum } from "./schemas";
/**
 * Datum = tag(0)=NoDatum | tag(1)=DatumHash+32B | tag(2)=Inline+ShortByteString.
 *
 * Returns a `DecodedInlineDatum` — the internal Schema-typed tagged union
 * (see `./schemas.ts`). The caller (TxOut decoder) converts this to the
 * externally-visible `DecodedDatumOption` shape; the internal vs. external
 * _tag numbering differs because Babbage's DatumOption only has two variants
 * (Hash/Inline — "none" is represented by the field being absent).
 */
export declare const readDatum: (view: DataView, offset: number) => {
    datum: DecodedInlineDatum;
    offset: number;
};
//# sourceMappingURL=datum.d.ts.map