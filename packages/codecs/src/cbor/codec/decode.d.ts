import { Effect } from "effect";
import { CborDecodeError } from "../CborError";
import { type CborValue } from "../CborValue";
export declare const parseSync: (input: Uint8Array) => CborValue;
export declare const parse: (bytes: Uint8Array) => Effect.Effect<CborValue, CborDecodeError>;
/**
 * Skip over a CBOR item in raw bytes without building an AST.
 * Returns the byte offset immediately after the item.
 *
 * Use this to extract original byte ranges from CBOR structures —
 * e.g. slicing the raw header body bytes for hashing instead of
 * re-encoding parsed AST (which may not be byte-identical).
 */
export declare const skipCborItem: (buf: Uint8Array, offset: number) => number;
//# sourceMappingURL=decode.d.ts.map