import { Schema, SchemaAST as AST } from "effect";
import { type CborValue } from "../CborValue";
import "./annotations";
/** A factory that builds a Link from a walked AST (children already walked). */
export type CborLinkFactory = (walkedAst: AST.AST) => AST.Link;
/**
 * Apply the Cardano `[tag, ...fields]` tagged-union encoding.
 *
 * The walker runs Effect's Objects parser on each member BEFORE this Link,
 * so on encode we receive a record where every non-tag field is already a
 * `CborValue` (encoded via the propertySignature's own encoding chain). The
 * tag field itself arrives as the raw literal because the walker strips the
 * tag propertySignature's encoding via `stripTagMemberEncodings` — that
 * lets us look up the member by exact sentinel match without a round-trip
 * through `literalLink`.
 *
 * On decode the direction is mirrored: we split the CBOR Array's head, use
 * it to select a member, and return a `{ [tagField]: rawTag, ...fields }`
 * record where fields are still `CborValue`s. Effect's Union dispatch then
 * matches the raw tag against member sentinels and runs the member's Objects
 * parser, which walks the remaining propertySignature encodings to produce
 * the final domain values.
 */
export declare const taggedUnionLink: (tagField: string) => CborLinkFactory;
/**
 * Return a list of `{ key, literal }` sentinels for a Union AST by walking
 * each member (collect-sentinels only recurses into Objects / Declaration).
 * Returns an empty array if any member lacks a literal sentinel at the
 * supplied tag field — the caller uses this to decide whether to auto-apply
 * Cardano tagged-union encoding.
 */
export declare const collectUnionSentinels: (union: AST.Union, tagField: string) => ReadonlyArray<AST.Sentinel>;
/**
 * Encode a `Schema.Struct` as a CBOR Map with integer keys.
 *
 * The walker attaches field-level encodings on each propertySignature before
 * this Link fires, so on encode we receive a record where every field value
 * is already a `CborValue` (for encoded fields) or `undefined` (for absent
 * optional fields). We simply arrange those pre-walked values into a
 * `Map(UInt(keyNum) → CborValue)` in integer-key-sorted order.
 *
 * Mirror on decode: emit `{ [field]: CborValue }` and let Effect's Objects
 * parser post-walk each propertySignature's encoding to produce the final
 * domain values.
 */
export declare const sparseMapLink: (keyMapping: Record<string, number>) => CborLinkFactory;
/**
 * Wrap the walked-AST's inner encoding in CBOR Tag(tagNum). Encode lifts the
 * inner link's output inside `{ _tag: Tag, tag: tagNum, data }`; decode
 * asserts the outer Tag variant + matching tag number before delegating.
 */
export declare const cborTaggedLink: (tagNum: bigint | number) => CborLinkFactory;
export declare const ENCODED_CBOR_TAG = 24n;
/**
 * Plain cborInCborLink: Tag(24)(Bytes(serialized(inner))) on encode; on
 * decode extracts Bytes, parses them as CBOR, runs `innerLink`. Re-encode
 * produces canonical bytes — non-canonical inputs get canonicalized. Use
 * {@link cborInCborPreserving} when hash stability matters.
 */
export declare const cborInCborLink: () => CborLinkFactory;
/**
 * Boxed form returned by {@link cborInCborPreserving}: carries the decoded
 * domain value alongside the raw inner CBOR bytes observed on the wire.
 * Hash-commitment callers (AuxiliaryData → `TxBody[7]`, TxBody → TxId,
 * TxWitnessSet → block-level commitment) re-emit `origBytes` verbatim so
 * `blake2b(re-encode(decode(x))) === blake2b(x)` holds even when the inner
 * CBOR was non-canonical on the wire. Values constructed by user code
 * without an `origBytes` field fall back to canonical re-encoding.
 */
export interface Preserved<T> {
    readonly value: T;
    readonly origBytes?: Uint8Array;
}
/**
 * Schema combinator wrapping an inner `Codec<T, CborValue>` in the RFC 8949
 * §3.4.5.1 "encoded CBOR" Tag(24)(Bytes) envelope **with byte preservation**.
 *
 * Declares a `Schema<Preserved<T>>` whose:
 *   - decode reads the inner Bytes payload, parses it, runs the inner codec
 *     on the parsed CborValue, and returns `{ value, origBytes }` with the
 *     raw bytes threaded through;
 *   - encode emits `origBytes` verbatim when present, else canonically
 *     re-encodes `value` through the inner codec.
 *
 * Implementation: builds a `Schema.declare` carrying a `toCborLink`
 * annotation. The walker's Declaration branch falls through to `applyCustom`
 * when no `toCodecCbor` is present and attaches the link — bypassing the
 * default declaration derivation that would otherwise recurse into
 * `CborValueSchema.ast` and attach spurious encoding to the target type.
 */
export declare const cborInCborPreserving: <T>(inner: Schema.Codec<T, CborValue, never, never>) => Schema.declare<Preserved<T>>;
/**
 * Schema combinator wrapping an inner `Codec<T, CborValue>` in the Haskell
 * `StrictMaybe` wire shape: `Array(0)` for Nothing, `Array(1, [x])` for Just.
 *
 * Declares a `Schema<T | undefined>` that decodes `[]` to `undefined` and
 * `[x]` to `inner.decode(x)`. Encode maps `undefined` to `[]` and any other
 * value to `[inner.encode(value)]`.
 *
 * Implementation matches {@link cborInCborPreserving}: `Schema.declare` with
 * a `toCborLink` annotation. Because the declaration has no `toCodecCbor`
 * annotation, the walker's Declaration branch falls through to
 * `applyCustom` and attaches the link directly — avoiding the default
 * recursion into `CborValueSchema.ast`.
 */
export declare const strictMaybe: <T>(inner: Schema.Codec<T, CborValue, never, never>) => Schema.declare<T | undefined>;
/**
 * Encode a `Schema.Struct` as a fixed-length positional CBOR Array. Like
 * {@link sparseMapLink}, this Link sits above the propertySignature-level
 * encoding chain: on encode each slot value arrives as a pre-walked
 * `CborValue` (or `undefined` for absent trailing-optional slots) and we
 * simply concatenate them in declared order.
 *
 * On decode we split the array by position and hand each slot's CBOR back
 * to Effect's Objects parser under the declared field name; the parser then
 * runs the propertySignature's encoding chain to produce the final domain
 * value.
 */
export declare const positionalArrayLink: (fieldOrder: ReadonlyArray<string>) => CborLinkFactory;
/** Is the supplied value a `CborLinkFactory`? Used by the walker. */
export declare const isCborLinkFactory: (u: unknown) => u is CborLinkFactory;
/**
 * Attach a `toCborLink` annotation to a schema. Equivalent to
 * `schema.annotate({ toCborLink: factory })` but marshals the factory type
 * through Effect's annotation system.
 */
export declare const withCborLink: <S extends Schema.Top>(factory: CborLinkFactory) => (schema: S) => S["Rebuild"];
//# sourceMappingURL=compositeLinks.d.ts.map