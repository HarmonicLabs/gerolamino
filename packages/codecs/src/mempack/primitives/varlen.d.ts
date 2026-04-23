import type { MemPackCodec } from "../MemPackCodec";
/** VarLen-encoded bigint (supports up to Word64 range in practice). */
export declare const varLen: MemPackCodec<bigint>;
/** Convenience: VarLen wrapper for values fitting in a JS number. */
export declare const varLenNumber: MemPackCodec<number>;
/**
 * `Length` — MemPack's length prefix for lists and variable-length data.
 * A VarLen Word with a sign-bit guard on decode: the high bit of the
 * underlying Word being set indicates the value would be negative when
 * reinterpreted as `Int`, which Haskell rejects (see the `MemPack Length`
 * instance in the reference). We mirror that guard here against JS's safe
 * integer limit.
 */
export declare const length: MemPackCodec<number>;
//# sourceMappingURL=varlen.d.ts.map