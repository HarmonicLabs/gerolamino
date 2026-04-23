import { Schema } from "effect";
import type { MemPackCodec } from "../MemPackCodec";
/**
 * Derive a `MemPackCodec<T>` from an Effect Schema by walking its AST.
 * Memoized per-AST-node; recursion cycles supported via `Schema.suspend` +
 * `AST.memoizeThunk`.
 *
 * The annotation `toCodecMemPack` (registered via module augmentation — see
 * `./annotations.ts`) overrides the default derivation for any schema.
 */
export declare const toCodecMemPack: <T, E, RD, RE>(ast: Schema.Codec<T, E, RD, RE>) => MemPackCodec<T>;
//# sourceMappingURL=toCodecMemPack.d.ts.map