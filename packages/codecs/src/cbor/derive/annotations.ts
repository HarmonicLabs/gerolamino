import type { Schema as SchemaNS, SchemaAST as AST } from "effect";

// ────────────────────────────────────────────────────────────────────────────
// Module augmentations for the `toCodecCbor` annotation + the walker
// primitives that Effect exposes at runtime but marks `@internal` (so they
// are stripped from the public `.d.ts`). Importing this file registers the
// types globally — nothing exported here is used at runtime.
//
// Anchor: `~/code/reference/effect-smol/packages/effect/src/SchemaAST.ts`
//  • `toCodec` (line 3108) — memoized encoding-chain walker
//  • `replaceEncoding` (line 2635) — set/replace `ast.encoding`
//  • `optionalKeyLastLink` (line 2768) — propagate optional flag through link
//  • `unknownToNull`, `unknownToJson` — scalar fallback Links (stubs)
//  • `Objects.recur` / `Arrays.recur` / `Union.recur` / `Suspend.recur` —
//     instance methods on composite node classes
// ────────────────────────────────────────────────────────────────────────────

declare module "effect/Schema" {
  namespace Annotations {
    interface Declaration<T, TypeParameters extends ReadonlyArray<SchemaNS.Top> = readonly []> {
      readonly toCodecCbor?:
        | ((typeParameters: TypeParameters.Encoded<TypeParameters>) => AST.Link)
        | undefined;
    }
  }
}

declare module "effect/SchemaAST" {
  // Walker primitives (top-level exports)
  export function toCodec(f: (ast: AST.AST) => AST.AST): (ast: AST.AST) => AST.AST;

  export function replaceEncoding<A extends AST.AST>(ast: A, encoding: AST.Encoding | undefined): A;

  export function optionalKeyLastLink<A extends AST.AST>(ast: A): A;

  // Scalar fallback Links used by Effect's own `toCodecJson` walker.
  export const unknownToNull: AST.Link;
  export const unknownToJson: AST.Link;

  // `recur` is a method on composite AST node classes. Each returns a new
  // node with children rewritten by the walker.
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

// Marker constant so the module is treated as a value module (required for
// the declare-module augmentations above to land in emitted `.d.ts` files).
export const TO_CODEC_CBOR_ANNOTATION = "toCodecCbor" as const;
