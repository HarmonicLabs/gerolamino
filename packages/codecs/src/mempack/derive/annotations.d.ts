import type { Schema as SchemaNS, SchemaAST as AST } from "effect";
import type { MemPackCodec } from "../MemPackCodec";
declare module "effect/Schema" {
    namespace Annotations {
        interface Declaration<T, TypeParameters extends ReadonlyArray<SchemaNS.Top> = readonly []> {
            readonly toCodecMemPack?: ((typeParameters: {
                readonly [K in keyof TypeParameters]: MemPackCodec<TypeParameters[K]["Type"]>;
            }) => MemPackCodec<T>) | undefined;
        }
    }
}
declare module "effect/SchemaAST" {
    type Sentinel = {
        readonly key: PropertyKey;
        readonly literal: AST.LiteralValue | symbol;
    };
    function collectSentinels(ast: AST.AST): Array<Sentinel>;
    function memoizeThunk<A>(f: () => A): () => A;
}
export type MemPackAnnotation<T, TypeParameters extends ReadonlyArray<unknown>> = (typeParameters: {
    readonly [K in keyof TypeParameters]: MemPackCodec<TypeParameters[K]>;
}) => MemPackCodec<T>;
/**
 * Private reader that retrieves the `toCodecMemPack` annotation without
 * widening the public annotation types. Returns `undefined` when the
 * annotation is absent.
 */
export declare const readMemPackAnnotation: (annotations: SchemaNS.Annotations.Bottom<unknown, ReadonlyArray<SchemaNS.Top>> | undefined) => MemPackAnnotation<unknown, ReadonlyArray<unknown>> | undefined;
export declare const TO_CODEC_MEMPACK_ANNOTATION: "toCodecMemPack";
//# sourceMappingURL=annotations.d.ts.map