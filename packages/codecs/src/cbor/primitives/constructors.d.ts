import { type CborValue } from "../CborValue";
export declare const cborUintValue: (n: bigint | number) => CborValue;
export declare const cborNegIntValue: (n: bigint | number) => CborValue;
export declare const cborBytesValue: (bytes: Uint8Array) => CborValue;
export declare const cborTextValue: (text: string) => CborValue;
export declare const cborArrayValue: (items: readonly CborValue[]) => CborValue;
export declare const cborMapValue: (entries: readonly {
    readonly k: CborValue;
    readonly v: CborValue;
}[]) => CborValue;
export declare const cborTagValue: (tag: bigint | number, data: CborValue) => CborValue;
export declare const cborBoolValue: (b: boolean) => CborValue;
export declare const cborNullValue: CborValue;
export declare const cborUndefinedValue: CborValue;
//# sourceMappingURL=constructors.d.ts.map