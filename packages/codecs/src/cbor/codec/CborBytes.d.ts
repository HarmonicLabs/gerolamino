import { Schema, SchemaTransformation } from "effect";
import { CborValue } from "../CborValue";
export declare const transformation: SchemaTransformation.Transformation<CborValue, Uint8Array>;
/** Codec<CborValue, Uint8Array> — the boundary between IR and wire format. */
export declare const CborBytes: Schema.decodeTo<Schema.toTaggedUnion<"_tag", readonly [Schema.TaggedStruct<import("codecs").CborKinds.UInt, {
    readonly num: Schema.BigInt;
    readonly addInfos: Schema.optional<Schema.Number>;
}>, Schema.TaggedStruct<import("codecs").CborKinds.NegInt, {
    readonly num: Schema.BigInt;
    readonly addInfos: Schema.optional<Schema.Number>;
}>, Schema.TaggedStruct<import("codecs").CborKinds.Bytes, {
    readonly bytes: Schema.Uint8Array;
    readonly addInfos: Schema.optional<Schema.Number>;
    readonly chunks: Schema.optional<Schema.$Array<Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>>>;
}>, Schema.TaggedStruct<import("codecs").CborKinds.Text, {
    readonly text: Schema.String;
    readonly addInfos: Schema.optional<Schema.Number>;
    readonly chunks: Schema.optional<Schema.$Array<Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>>>;
}>, Schema.TaggedStruct<import("codecs").CborKinds.Array, {
    readonly items: Schema.$Array<Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>>;
    readonly addInfos: Schema.optional<Schema.Number>;
}>, Schema.TaggedStruct<import("codecs").CborKinds.Map, {
    readonly entries: Schema.$Array<Schema.Struct<{
        readonly k: Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>;
        readonly v: Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>;
    }>>;
    readonly addInfos: Schema.optional<Schema.Number>;
}>, Schema.TaggedStruct<import("codecs").CborKinds.Tag, {
    readonly tag: Schema.BigInt;
    readonly data: Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>;
    readonly addInfos: Schema.optional<Schema.Number>;
}>, Schema.TaggedStruct<import("codecs").CborKinds.Simple, {
    readonly value: Schema.Union<readonly [Schema.Boolean, Schema.Null, Schema.BigDecimal, Schema.Undefined]>;
    readonly addInfos: Schema.optional<Schema.Number>;
}>]>, Schema.Uint8Array, never, never>;
//# sourceMappingURL=CborBytes.d.ts.map