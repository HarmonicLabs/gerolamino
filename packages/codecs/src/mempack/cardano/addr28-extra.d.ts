import type { DecodedAddr28Extra } from "./schemas";
/**
 * Addr28Extra = 4 × Word64-LE = 32 bytes. Encodes the payment-credential
 * hash (28 bytes) plus network / script flags in the low bits of the last
 * Word64.
 *
 * Word 3 (bytes 24-31) layout:
 *   bit 0: 0 = Script, 1 = Key (inverted vs. the Credential-tag convention!)
 *   bit 1: 0 = Testnet, 1 = Mainnet
 *   remaining bits: upper portion of the hash
 *
 * Returns a `DecodedAddr28Extra` — a Schema-typed struct from `./schemas.ts`.
 */
export declare const readAddr28Extra: (view: DataView, offset: number) => DecodedAddr28Extra & {
    offset: number;
};
//# sourceMappingURL=addr28-extra.d.ts.map