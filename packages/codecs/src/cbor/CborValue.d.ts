import { BigDecimal, Schema } from "effect";
export declare enum CborKinds {
    UInt = 0,
    NegInt = 1,
    Bytes = 2,
    Text = 3,
    Array = 4,
    Map = 5,
    Tag = 6,
    Simple = 7
}
export declare namespace CborKinds {
    const MAJOR_TYPE_SHIFT = 5;
    const ADD_INFOS_MASK = 31;
    const BREAK = 255;
    const INLINE_MAX = 23;
    const AI_1BYTE = 24;
    const AI_2BYTE = 25;
    const AI_4BYTE = 26;
    const AI_8BYTE = 27;
    const AI_INDEFINITE = 31;
    const SIMPLE_FALSE = 20;
    const SIMPLE_TRUE = 21;
    const SIMPLE_NULL = 22;
    const SIMPLE_UNDEFINED = 23;
    const OVERFLOW_1 = 256;
    const OVERFLOW_2 = 65536;
    const OVERFLOW_4 = 4294967296n;
    const MAX_UINT64: bigint;
    const MIN_NEG_INT64: bigint;
}
export type CborValue = {
    readonly _tag: CborKinds.UInt;
    readonly num: bigint;
    readonly addInfos?: number | undefined;
} | {
    readonly _tag: CborKinds.NegInt;
    readonly num: bigint;
    readonly addInfos?: number | undefined;
} | {
    readonly _tag: CborKinds.Bytes;
    readonly bytes: Uint8Array;
    readonly addInfos?: number | undefined;
    readonly chunks?: readonly CborValue[] | undefined;
} | {
    readonly _tag: CborKinds.Text;
    readonly text: string;
    readonly addInfos?: number | undefined;
    readonly chunks?: readonly CborValue[] | undefined;
} | {
    readonly _tag: CborKinds.Simple;
    readonly value: boolean | null | BigDecimal.BigDecimal | undefined;
    readonly addInfos?: number | undefined;
} | {
    readonly _tag: CborKinds.Array;
    readonly items: readonly CborValue[];
    readonly addInfos?: number | undefined;
} | {
    readonly _tag: CborKinds.Map;
    readonly entries: readonly {
        readonly k: CborValue;
        readonly v: CborValue;
    }[];
    readonly addInfos?: number | undefined;
} | {
    readonly _tag: CborKinds.Tag;
    readonly tag: bigint;
    readonly data: CborValue;
    readonly addInfos?: number | undefined;
};
/** Back-compat alias for the former name. */
export type CborSchemaType = CborValue;
export declare const CborLeavesSchema: Schema.toTaggedUnion<"_tag", readonly [Schema.TaggedStruct<CborKinds.UInt, {
    readonly num: Schema.BigInt;
    readonly addInfos: Schema.optional<Schema.Number>;
}>, Schema.TaggedStruct<CborKinds.NegInt, {
    readonly num: Schema.BigInt;
    readonly addInfos: Schema.optional<Schema.Number>;
}>, Schema.TaggedStruct<CborKinds.Simple, {
    readonly value: Schema.Union<readonly [Schema.Boolean, Schema.Null, Schema.BigDecimal, Schema.Undefined]>;
    readonly addInfos: Schema.optional<Schema.Number>;
}>]>;
export declare const CborValue: Schema.toTaggedUnion<"_tag", readonly [Schema.TaggedStruct<CborKinds.UInt, {
    readonly num: Schema.BigInt;
    readonly addInfos: Schema.optional<Schema.Number>;
}>, Schema.TaggedStruct<CborKinds.NegInt, {
    readonly num: Schema.BigInt;
    readonly addInfos: Schema.optional<Schema.Number>;
}>, Schema.TaggedStruct<CborKinds.Bytes, {
    readonly bytes: Schema.Uint8Array;
    readonly addInfos: Schema.optional<Schema.Number>;
    readonly chunks: Schema.optional<Schema.$Array<Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>>>;
}>, Schema.TaggedStruct<CborKinds.Text, {
    readonly text: Schema.String;
    readonly addInfos: Schema.optional<Schema.Number>;
    readonly chunks: Schema.optional<Schema.$Array<Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>>>;
}>, Schema.TaggedStruct<CborKinds.Array, {
    readonly items: Schema.$Array<Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>>;
    readonly addInfos: Schema.optional<Schema.Number>;
}>, Schema.TaggedStruct<CborKinds.Map, {
    readonly entries: Schema.$Array<Schema.Struct<{
        readonly k: Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>;
        readonly v: Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>;
    }>>;
    readonly addInfos: Schema.optional<Schema.Number>;
}>, Schema.TaggedStruct<CborKinds.Tag, {
    readonly tag: Schema.BigInt;
    readonly data: Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>;
    readonly addInfos: Schema.optional<Schema.Number>;
}>, Schema.TaggedStruct<CborKinds.Simple, {
    readonly value: Schema.Union<readonly [Schema.Boolean, Schema.Null, Schema.BigDecimal, Schema.Undefined]>;
    readonly addInfos: Schema.optional<Schema.Number>;
}>]>;
/** Back-compat alias for the former schema name. */
export declare const CborSchema: Schema.toTaggedUnion<"_tag", readonly [Schema.TaggedStruct<CborKinds.UInt, {
    readonly num: Schema.BigInt;
    readonly addInfos: Schema.optional<Schema.Number>;
}>, Schema.TaggedStruct<CborKinds.NegInt, {
    readonly num: Schema.BigInt;
    readonly addInfos: Schema.optional<Schema.Number>;
}>, Schema.TaggedStruct<CborKinds.Bytes, {
    readonly bytes: Schema.Uint8Array;
    readonly addInfos: Schema.optional<Schema.Number>;
    readonly chunks: Schema.optional<Schema.$Array<Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>>>;
}>, Schema.TaggedStruct<CborKinds.Text, {
    readonly text: Schema.String;
    readonly addInfos: Schema.optional<Schema.Number>;
    readonly chunks: Schema.optional<Schema.$Array<Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>>>;
}>, Schema.TaggedStruct<CborKinds.Array, {
    readonly items: Schema.$Array<Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>>;
    readonly addInfos: Schema.optional<Schema.Number>;
}>, Schema.TaggedStruct<CborKinds.Map, {
    readonly entries: Schema.$Array<Schema.Struct<{
        readonly k: Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>;
        readonly v: Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>;
    }>>;
    readonly addInfos: Schema.optional<Schema.Number>;
}>, Schema.TaggedStruct<CborKinds.Tag, {
    readonly tag: Schema.BigInt;
    readonly data: Schema.suspend<Schema.Codec<CborValue, CborValue, never, never>>;
    readonly addInfos: Schema.optional<Schema.Number>;
}>, Schema.TaggedStruct<CborKinds.Simple, {
    readonly value: Schema.Union<readonly [Schema.Boolean, Schema.Null, Schema.BigDecimal, Schema.Undefined]>;
    readonly addInfos: Schema.optional<Schema.Number>;
}>]>;
//# sourceMappingURL=CborValue.d.ts.map