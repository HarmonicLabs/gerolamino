import { Schema, SchemaAST as AST } from "effect";
import { type CborValue } from "../CborValue";
import "./annotations";
export declare const deriveCborWalker: (ast: AST.AST) => AST.AST;
/**
 * Derive a Codec<T, CborValue> from a schema. Walks the AST arm-by-arm,
 * attaching Links that transform each TS type to/from its CborValue
 * representation (primitives emit scalar variants; Struct emits Map; Array
 * emits Array).
 */
export declare const toCodecCbor: <T, E, RD, RE>(schema: Schema.Codec<T, E, RD, RE>) => Schema.Codec<T, CborValue, RD, RE>;
/**
 * Derive a Codec<T, Uint8Array> by composing `toCodecCbor` with the
 * `CborBytes` codec that serializes CborValue to RFC 8949 wire bytes.
 *
 * Composition direction: Uint8Array ← CborBytes → CborValue ← toCodecCbor →
 * T. Start at the encoded end (CborBytes: Codec<CborValue, Uint8Array>) and
 * decode up to the domain type via `decodeTo`.
 */
export declare const toCodecCborBytes: <T, E, RD, RE>(schema: Schema.Codec<T, E, RD, RE>) => Schema.Codec<T, Uint8Array, RD, RE>;
//# sourceMappingURL=toCodecCbor.d.ts.map