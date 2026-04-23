import { BigDecimal } from "effect";
import { type CborValue } from "../CborValue";
/** Extract the `num` field from a CBOR UInt node. Throws if not UInt. */
export declare const cborUint: (node: CborValue, label?: string) => bigint;
/** Extract the `num` field from a CBOR NegInt node. Throws if not NegInt. */
export declare const cborNegInt: (node: CborValue, label?: string) => bigint;
/** Extract the `bytes` field from a CBOR Bytes node. Throws if not Bytes. */
export declare const cborBytes: (node: CborValue, label?: string) => Uint8Array;
/** Extract the `text` field from a CBOR Text node. Throws if not Text. */
export declare const cborText: (node: CborValue, label?: string) => string;
/** Extract the `items` array from a CBOR Array node. Throws if not Array. */
export declare const cborArray: (node: CborValue, label?: string) => readonly CborValue[];
/** Extract the `entries` from a CBOR Map node. Throws if not Map. */
export declare const cborMap: (node: CborValue, label?: string) => readonly {
    readonly k: CborValue;
    readonly v: CborValue;
}[];
/** Extract the `value` field from a CBOR Simple node. Throws if not Simple. */
export declare const cborSimple: (node: CborValue, label?: string) => boolean | null | BigDecimal.BigDecimal | undefined;
/** Extract boolean from a CBOR Simple node. Throws if not a boolean Simple. */
export declare const cborBool: (node: CborValue, label?: string) => boolean;
//# sourceMappingURL=narrow.d.ts.map