import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { CryptoStub } from "../../__tests__/crypto-stub.ts";
import { ValidationClient } from "../validation-client.ts";
import { ValidationDirectLayer } from "../validation-direct-layer.ts";

/**
 * Contract tests for `ValidationDirectLayer`. Primitive crypto methods
 * delegate to the `Crypto` service (stubbed here); consensus-level
 * methods that aren't yet implemented fail with a ValidationError.
 *
 * Worker-layer tests defer until Phase 5 wires the Bun.Worker spawn.
 */

const ValidationTestLayer = ValidationDirectLayer.pipe(Layer.provideMerge(CryptoStub));

describe("ValidationDirectLayer", () => {
  it.effect("computeBodyHash produces a 32-byte blake2b-256 digest", () =>
    Effect.gen(function* () {
      const client = yield* ValidationClient;
      const hash = yield* client.computeBodyHash(new Uint8Array([1, 2, 3]));
      expect(hash.length).toBe(32);
    }).pipe(Effect.provide(ValidationTestLayer)),
  );

  it.effect("computeTxId is deterministic", () =>
    Effect.gen(function* () {
      const client = yield* ValidationClient;
      const tx = new Uint8Array([4, 5, 6, 7, 8]);
      const a = yield* client.computeTxId(tx);
      const b = yield* client.computeTxId(tx);
      expect(a).toEqual(b);
    }).pipe(Effect.provide(ValidationTestLayer)),
  );

  it.effect("blake2b256Tagged differs from untagged for the same data", () =>
    Effect.gen(function* () {
      const client = yield* ValidationClient;
      const data = new Uint8Array([1, 2, 3]);
      const tagged = yield* client.blake2b256Tagged(0x4c, data);
      const body = yield* client.computeBodyHash(data);
      expect(tagged).not.toEqual(body); // different prefix → different hash
    }).pipe(Effect.provide(ValidationTestLayer)),
  );

  it.effect("decodeBlockCbor fails cleanly on invalid CBOR", () =>
    Effect.gen(function* () {
      const client = yield* ValidationClient;
      const exit = yield* Effect.exit(client.decodeBlockCbor(new Uint8Array([0xff])));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(ValidationTestLayer)),
  );
});
