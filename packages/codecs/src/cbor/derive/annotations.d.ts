import type { Schema as SchemaNS, SchemaAST as AST } from "effect";
import type { CborLinkFactory } from "./compositeLinks";
declare module "effect/Schema" {
    namespace Annotations {
        interface Declaration<T, TypeParameters extends ReadonlyArray<SchemaNS.Top> = readonly []> {
            readonly toCodecCbor?: ((typeParameters: TypeParameters.Encoded<TypeParameters>) => AST.Link) | undefined;
        }
        interface Annotations {
            /**
             * Attach a Cardano-flavoured composite CBOR Link factory (tagged-union,
             * sparse-map, positional-array, Tag(n), Tag(24) encoded-CBOR, StrictMaybe).
             * The walker invokes the factory after recurring into children, passing
             * the walked AST; the factory returns an `AST.Link` that replaces the
             * node's default encoding.
             */
            readonly toCborLink?: CborLinkFactory | undefined;
        }
    }
}
declare module "effect/SchemaAST" {
    function toCodec(f: (ast: AST.AST) => AST.AST): (ast: AST.AST) => AST.AST;
    function replaceEncoding<A extends AST.AST>(ast: A, encoding: AST.Encoding | undefined): A;
    function optionalKeyLastLink<A extends AST.AST>(ast: A): A;
    const unknownToNull: AST.Link;
    const unknownToJson: AST.Link;
    interface Objects {
        recur(recur: (ast: AST.AST) => AST.AST): AST.AST;
    }
    interface Arrays {
        recur(recur: (ast: AST.AST) => AST.AST): AST.AST;
    }
    interface Union<A extends AST.AST = AST.AST> {
        recur(recur: (ast: AST.AST) => AST.AST): AST.AST;
    }
    interface Suspend {
        recur(recur: (ast: AST.AST) => AST.AST): AST.AST;
    }
}
export declare const TO_CODEC_CBOR_ANNOTATION: "toCodecCbor";
//# sourceMappingURL=annotations.d.ts.map