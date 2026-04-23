import { Effect, Option, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { CborValue } from "../CborValue";
import { parse } from "./decode";
import { encode } from "./encode";

export const transformation: SchemaTransformation.Transformation<CborValue, Uint8Array> =
  SchemaTransformation.transformOrFail({
    decode: (bytes, _options) =>
      parse(bytes).pipe(
        Effect.mapError(
          (e) => new SchemaIssue.InvalidValue(Option.some(bytes), { message: String(e) }),
        ),
      ),
    encode: (ast, _options) =>
      encode(ast).pipe(
        Effect.mapError(
          (e) => new SchemaIssue.InvalidValue(Option.some(ast), { message: String(e) }),
        ),
      ),
  });

/** Codec<CborValue, Uint8Array> — the boundary between IR and wire format. */
export const CborBytes = Schema.Uint8Array.pipe(Schema.decodeTo(CborValue, transformation));
