import { Optic, Schema } from "effect";
import { CborKinds, type CborValue } from "../CborValue";
export declare const toCborIso: <T, E>(schema: Schema.Codec<T, E, never, never>) => Optic.Iso<T, CborValue>;
export declare namespace CborValueOptics {
    const uint: Optic.Prism<CborValue, {
        readonly _tag: CborKinds.UInt;
        readonly num: bigint;
        readonly addInfos?: number | undefined;
    }>;
    const negInt: Optic.Prism<CborValue, {
        readonly _tag: CborKinds.NegInt;
        readonly num: bigint;
        readonly addInfos?: number | undefined;
    }>;
    const bytes: Optic.Prism<CborValue, {
        readonly _tag: CborKinds.Bytes;
        readonly bytes: Uint8Array;
        readonly addInfos?: number | undefined;
        readonly chunks?: readonly CborValue[] | undefined;
    }>;
    const text: Optic.Prism<CborValue, {
        readonly _tag: CborKinds.Text;
        readonly text: string;
        readonly addInfos?: number | undefined;
        readonly chunks?: readonly CborValue[] | undefined;
    }>;
    const array: Optic.Prism<CborValue, {
        readonly _tag: CborKinds.Array;
        readonly items: readonly CborValue[];
        readonly addInfos?: number | undefined;
    }>;
    const map: Optic.Prism<CborValue, {
        readonly _tag: CborKinds.Map;
        readonly entries: readonly {
            readonly k: CborValue;
            readonly v: CborValue;
        }[];
        readonly addInfos?: number | undefined;
    }>;
    const tag: Optic.Prism<CborValue, {
        readonly _tag: CborKinds.Tag;
        readonly tag: bigint;
        readonly data: CborValue;
        readonly addInfos?: number | undefined;
    }>;
    const simple: Optic.Prism<CborValue, {
        readonly _tag: CborKinds.Simple;
        readonly value: boolean | null | import("effect/BigDecimal").BigDecimal | undefined;
        readonly addInfos?: number | undefined;
    }>;
}
export declare namespace CborValueTraversals {
    /** Every element inside a CBOR Array variant. */
    const arrayItems: Optic.Traversal<CborValue, CborValue>;
    /** Every value slot inside a CBOR Map variant (keys untouched). */
    const mapValues: Optic.Traversal<CborValue, CborValue>;
    /** Every key slot inside a CBOR Map variant (values untouched). */
    const mapKeys: Optic.Traversal<CborValue, CborValue>;
    /** The inner payload of a Tag variant. */
    const tagData: Optic.Optional<CborValue, CborValue>;
}
//# sourceMappingURL=toIso.d.ts.map