import { Schema } from "effect";
import type { MemPackCodec } from "../MemPackCodec";
/**
 * Lift a `MemPackCodec<T>` into `Schema.Codec<T, Uint8Array>` so MemPack
 * codecs compose with the rest of the Effect Schema ecosystem (layerable
 * via `Schema.decodeTo`, observable via `Schema.encodeUnknownEffect`,
 * errors flow as `Issue`).
 *
 * Pattern mirrors Effect's own Msgpack wrapper at
 * `~/code/reference/effect-smol/packages/effect/src/unstable/encoding/Msgpack.ts:264-299`:
 * `Schema.Uint8Array.pipe(Schema.decodeTo(schema, Transformation.transformOrFail(...)))`.
 *
 * Use this at API boundaries — entrypoints that want to emit/consume
 * Schema-native Codec values (e.g., storage layers, RPC marshalling). For
 * direct bytewise work, `packToUint8Array` / `unpackFromUint8Array` remain
 * the lowest-overhead path.
 */
export declare const toCodecMemPackBytes: <T>(schema: Schema.Codec<T, T, never, never>, codec: MemPackCodec<T>) => Schema.Codec<T, Uint8Array<ArrayBufferLike>, never, never>;
//# sourceMappingURL=toCodecMemPackBytes.d.ts.map