/**
 * Cross-layer parity — `ValidationClient` resolved via `ValidationDirectLayer`
 * must produce byte-identical outputs to resolution via `ValidationWorkerBun`.
 *
 * Any drift signals a bug in:
 *   - `RpcSerialization.layerMsgPack` round-trip
 *   - `Transferable.schema` ArrayBuffer hand-off
 *   - worker-side `CryptoDirect` bootstrap
 *   - consensus-level method wiring (ValidationDirectLayer ↔ handlers)
 *
 * Only exercises methods that are actually implemented today —
 * ValidateHeader / ValidateBlockBody / DecodeHeaderCbor are deferred to
 * Phase 3b and both layers fail them identically, so they're not parity
 * subjects until the real implementation lands.
 */
import { describe, expect, layer } from "@effect/vitest";
import { Context, Effect, Equal, Layer } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { CryptoDirect, ed25519_public_key, ed25519_secret_key_from_seed, ed25519_sign } from "wasm-utils";

import { ValidationClient } from "../validation-client.ts";
import { ValidationDirectLayer } from "../validation-direct-layer.ts";
import { ValidationWorkerBun } from "../bun.ts";

class DirectTag extends Context.Service<DirectTag, ValidationClient["Service"]>()(
  "consensus/test/ValidationDirectTag",
) {}
class WorkerTag extends Context.Service<WorkerTag, ValidationClient["Service"]>()(
  "consensus/test/ValidationWorkerTag",
) {}

const DirectTagLive: Layer.Layer<DirectTag> = Layer.effect(DirectTag, Effect.service(ValidationClient)).pipe(
  Layer.provide(ValidationDirectLayer),
  Layer.provide(CryptoDirect),
);

const WorkerTagLive: Layer.Layer<WorkerTag> = Layer.effect(WorkerTag, Effect.service(ValidationClient)).pipe(
  Layer.provide(ValidationWorkerBun),
  Layer.provide(CryptoDirect),
  Layer.orDie,
);

const Pair: Layer.Layer<DirectTag | WorkerTag> = Layer.mergeAll(DirectTagLive, WorkerTagLive);

const payload = FastCheck.uint8Array({ minLength: 1, maxLength: 512 });
const seed32 = FastCheck.uint8Array({ minLength: 32, maxLength: 32 });

layer(Pair)("ValidationClient parity — Direct vs Worker", (it) => {
  describe("computeBodyHash / computeTxId (Crypto.blake2b256 via shared WASM)", () => {
    it.effect.prop(
      "computeBodyHash byte-identical",
      [payload],
      ([data]) =>
        Effect.gen(function* () {
          const direct = yield* DirectTag;
          const worker = yield* WorkerTag;
          const a = yield* direct.computeBodyHash(data);
          const b = yield* worker.computeBodyHash(data);
          expect(a.byteLength).toBe(32);
          expect(Equal.equals(a, b)).toBe(true);
        }),
      { fastCheck: { numRuns: 30 } },
    );

    it.effect.prop(
      "computeTxId byte-identical",
      [payload],
      ([data]) =>
        Effect.gen(function* () {
          const direct = yield* DirectTag;
          const worker = yield* WorkerTag;
          const a = yield* direct.computeTxId(data);
          const b = yield* worker.computeTxId(data);
          expect(Equal.equals(a, b)).toBe(true);
        }),
      { fastCheck: { numRuns: 30 } },
    );
  });

  describe("blake2b256Tagged", () => {
    it.effect.prop(
      "byte-identical with same tag",
      [payload, FastCheck.integer({ min: 0, max: 255 })],
      ([data, tag]) =>
        Effect.gen(function* () {
          const direct = yield* DirectTag;
          const worker = yield* WorkerTag;
          const a = yield* direct.blake2b256Tagged(tag, data);
          const b = yield* worker.blake2b256Tagged(tag, data);
          expect(Equal.equals(a, b)).toBe(true);
        }),
      { fastCheck: { numRuns: 30 } },
    );
  });

  describe("ed25519Verify (delegates to Crypto — Worker adds RPC round-trip)", () => {
    it.effect.prop(
      "agree on valid sign+verify",
      [seed32, payload],
      ([seed, message]) =>
        Effect.gen(function* () {
          const direct = yield* DirectTag;
          const worker = yield* WorkerTag;
          const sk = ed25519_secret_key_from_seed(seed);
          const pk = ed25519_public_key(sk);
          const sig = ed25519_sign(message, sk);
          const a = yield* direct.ed25519Verify(message, sig, pk);
          const b = yield* worker.ed25519Verify(message, sig, pk);
          expect(a).toBe(true);
          expect(b).toBe(true);
        }),
      { fastCheck: { numRuns: 20 } },
    );
  });
});
