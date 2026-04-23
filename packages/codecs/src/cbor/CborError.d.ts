import { Schema } from "effect";
declare const CborDecodeError_base: Schema.Class<CborDecodeError, Schema.TaggedStruct<"CborDecodeError", {
    readonly cause: Schema.Defect;
}>, import("effect/Cause").YieldableError>;
export declare class CborDecodeError extends CborDecodeError_base {
}
declare const CborEncodeError_base: Schema.Class<CborEncodeError, Schema.TaggedStruct<"CborEncodeError", {
    readonly cause: Schema.Defect;
}>, import("effect/Cause").YieldableError>;
export declare class CborEncodeError extends CborEncodeError_base {
}
export {};
//# sourceMappingURL=CborError.d.ts.map