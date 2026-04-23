import type { DecodedCredential } from "./schemas";
/**
 * Credential = tag(0)=ScriptHash | tag(1)=KeyHash + 28-byte hash (blake2b-224).
 * Note: the Credential tag numbering is OPPOSITE of Addr28Extra's bit-0 flag
 * (where 0=Script, 1=Key → inverted on decode).
 *
 * Returns a `DecodedCredential` — a Schema-typed struct from `./schemas.ts`.
 */
export declare const readCredential: (view: DataView, offset: number) => DecodedCredential & {
    offset: number;
};
//# sourceMappingURL=credential.d.ts.map