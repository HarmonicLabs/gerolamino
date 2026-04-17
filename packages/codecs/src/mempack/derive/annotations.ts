import type { Schema as SchemaNS, SchemaAST as AST } from "effect";
import type { MemPackCodec } from "../MemPackCodec";

// ────────────────────────────────────────────────────────────────────────────
// Module augmentations for the `toCodecMemPack` annotation + the walker
// primitives that Effect exposes at runtime but marks `@internal` (so they
// are stripped from the public `.d.ts`). Importing this file registers the
// types globally — nothing exported here is used at runtime.
//
// Anchor: `~/code/reference/effect-smol/packages/effect/src/SchemaAST.ts`
//  • `collectSentinels` (line 2090) — detect literal discriminators on union
//     members for tagged-union dispatch
//  • `memoizeThunk` (line 2373) — break recursion cycles in Suspend branches
//  • `Sentinel` (line 2035) — return shape of collectSentinels
//
// MemPack's annotation follows the CBOR pattern (augment `Annotations.Declaration`
// not `Annotations.Bottom`) — augmenting `Bottom` cascades the annotation's
// generic `T` through every schema builder, causing variance-related type
// breakage on `TaggedStruct.annotate` and its siblings.
// ────────────────────────────────────────────────────────────────────────────

declare module "effect/Schema" {
  namespace Annotations {
    interface Declaration<T, TypeParameters extends ReadonlyArray<SchemaNS.Top> = readonly []> {
      readonly toCodecMemPack?:
        | ((typeParameters: {
            readonly [K in keyof TypeParameters]: MemPackCodec<TypeParameters[K]["Type"]>;
          }) => MemPackCodec<T>)
        | undefined;
    }
  }
}

declare module "effect/SchemaAST" {
  // Tagged-union discriminator detection (public semantics; `@internal` export).
  export type Sentinel = {
    readonly key: PropertyKey;
    readonly literal: AST.LiteralValue | symbol;
  };
  export function collectSentinels(ast: AST.AST): Array<Sentinel>;

  // Lazy-thunk memoization used by Suspend branches (mirrors toArbitrary).
  export function memoizeThunk<A>(f: () => A): () => A;
}

export type MemPackAnnotation<T, TypeParameters extends ReadonlyArray<unknown>> = (typeParameters: {
  readonly [K in keyof TypeParameters]: MemPackCodec<TypeParameters[K]>;
}) => MemPackCodec<T>;

/**
 * Private reader that retrieves the `toCodecMemPack` annotation without
 * widening the public annotation types. Returns `undefined` when the
 * annotation is absent.
 */
export const readMemPackAnnotation = (
  annotations: SchemaNS.Annotations.Bottom<unknown, ReadonlyArray<SchemaNS.Top>> | undefined,
): MemPackAnnotation<unknown, ReadonlyArray<unknown>> | undefined =>
  (annotations as { readonly toCodecMemPack?: unknown } | undefined)?.toCodecMemPack as
    | MemPackAnnotation<unknown, ReadonlyArray<unknown>>
    | undefined;

// Marker constant so the module is treated as a value module (required for
// the declare-module augmentations above to land in emitted `.d.ts` files).
export const TO_CODEC_MEMPACK_ANNOTATION = "toCodecMemPack" as const;
