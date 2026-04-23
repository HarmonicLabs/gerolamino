import { Schema } from "effect";
declare const MemPackDecodeError_base: Schema.Class<MemPackDecodeError, Schema.TaggedStruct<"MemPackDecodeError", {
    readonly cause: Schema.Defect;
}>, import("effect/Cause").YieldableError>;
export declare class MemPackDecodeError extends MemPackDecodeError_base {
}
declare const MemPackEncodeError_base: Schema.Class<MemPackEncodeError, Schema.TaggedStruct<"MemPackEncodeError", {
    readonly cause: Schema.Defect;
}>, import("effect/Cause").YieldableError>;
export declare class MemPackEncodeError extends MemPackEncodeError_base {
}
export {};
//# sourceMappingURL=MemPackError.d.ts.map