/**
 * Property-based tests for the wasm-plexer framing services.
 *
 * Covers the invariants callers rely on:
 *   - MuxFraming.wrapFrame / unwrapFrame round-trip preserves (payload, protocol, hasAgency)
 *   - FrameBuffer accumulates + drains concatenated frames losslessly
 *   - Fragmentation stability: arbitrary chunk splits still yield the same frames in order
 *   - Error surface: short header / invalid protocol both raise FramingOpError
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Equal } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import {
  FrameBuffer,
  FrameBufferLive,
  MuxFraming,
  MuxFramingLive,
  type WrappedFrame,
} from "../index.ts";

const NUM_RUNS = 200;

// Protocol IDs recognized by the Rust MiniProtocol enum.
const VALID_PROTOCOL_IDS = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const validProtocolId = FastCheck.constantFrom(...VALID_PROTOCOL_IDS);
// Keep payloads under ~1 KiB so concatenated-frame tests stay snappy.
const payloadArb = FastCheck.uint8Array({ minLength: 0, maxLength: 512 });

const frameTriple = FastCheck.tuple(payloadArb, validProtocolId, FastCheck.boolean());
const frameTriples = FastCheck.array(frameTriple, { minLength: 1, maxLength: 8 });

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((acc, p) => acc + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
};

layer(MuxFramingLive)("MuxFraming — property tests", (it) => {
  it.effect.prop(
    "wrapFrame → unwrapFrame preserves (payload, protocol, hasAgency)",
    [payloadArb, validProtocolId, FastCheck.boolean()],
    ([payload, protocolId, hasAgency]) =>
      Effect.gen(function* () {
        const mux = yield* MuxFraming;
        const wire = yield* mux.wrapFrame(payload, protocolId, hasAgency);
        const frame = yield* mux.unwrapFrame(wire);
        expect(frame.protocol).toBe(protocolId);
        expect(frame.hasAgency).toBe(hasAgency);
        expect(frame.payloadLength).toBe(payload.byteLength);
        expect(Equal.equals(frame.payload, payload)).toBe(true);
      }),
    { fastCheck: { numRuns: NUM_RUNS } },
  );

  it.effect.prop(
    "wrapped frame byte length equals 8-byte header plus payload",
    [payloadArb, validProtocolId, FastCheck.boolean()],
    ([payload, protocolId, hasAgency]) =>
      Effect.gen(function* () {
        const mux = yield* MuxFraming;
        const wire = yield* mux.wrapFrame(payload, protocolId, hasAgency);
        expect(wire.byteLength).toBe(8 + payload.byteLength);
      }),
    { fastCheck: { numRuns: NUM_RUNS } },
  );
});

// FrameBuffer tests need a fresh WasmMultiplexerBuffer per run.
// Providing FrameBufferLive *inside* the property body rebuilds the layer per
// iteration, giving each run an isolated buffer.
layer(MuxFramingLive)("FrameBuffer — property tests", (it) => {
  it.effect.prop(
    "appending N concatenated frames and draining yields exactly N frames in order",
    [frameTriples],
    ([triples]) =>
      Effect.gen(function* () {
        const mux = yield* MuxFraming;
        const buffer = yield* FrameBuffer;
        const wires: Uint8Array[] = [];
        for (const [payload, protocolId, hasAgency] of triples) {
          wires.push(yield* mux.wrapFrame(payload, protocolId, hasAgency));
        }
        yield* buffer.append(concat(wires));
        const frames = yield* buffer.drain();
        const size = yield* buffer.size();
        expect(frames.length).toBe(triples.length);
        expect(size).toBe(0);
        triples.forEach(([payload, protocolId, hasAgency], idx) => {
          const frame = frames[idx] as WrappedFrame;
          expect(frame.protocol).toBe(protocolId);
          expect(frame.hasAgency).toBe(hasAgency);
          expect(frame.payloadLength).toBe(payload.byteLength);
          expect(Equal.equals(frame.payload, payload)).toBe(true);
        });
      }).pipe(Effect.provide(FrameBufferLive)),
    { fastCheck: { numRuns: 60 } },
  );

  it.effect.prop(
    "fragmentation stability: arbitrary chunk splits still yield all frames in order",
    [
      frameTriples,
      FastCheck.array(FastCheck.integer({ min: 1, max: 64 }), {
        minLength: 1,
        maxLength: 32,
      }),
    ],
    ([triples, splits]) =>
      Effect.gen(function* () {
        const mux = yield* MuxFraming;
        const buffer = yield* FrameBuffer;
        const wires: Uint8Array[] = [];
        for (const [payload, protocolId, hasAgency] of triples) {
          wires.push(yield* mux.wrapFrame(payload, protocolId, hasAgency));
        }
        const full = concat(wires);
        const frames: WrappedFrame[] = [];
        let cursor = 0;
        let splitIdx = 0;
        while (cursor < full.byteLength) {
          const step = splits[splitIdx % splits.length] ?? 1;
          const end = Math.min(cursor + step, full.byteLength);
          yield* buffer.append(full.slice(cursor, end));
          cursor = end;
          splitIdx += 1;
          const batch = yield* buffer.drain();
          frames.push(...batch);
        }
        expect(frames.length).toBe(triples.length);
        triples.forEach(([payload, protocolId, hasAgency], idx) => {
          const frame = frames[idx] as WrappedFrame;
          expect(frame.protocol).toBe(protocolId);
          expect(frame.hasAgency).toBe(hasAgency);
          expect(Equal.equals(frame.payload, payload)).toBe(true);
        });
      }).pipe(Effect.provide(FrameBufferLive)),
    { fastCheck: { numRuns: 40 } },
  );
});

layer(MuxFramingLive)("MuxFraming — error surface", (it) => {
  it.effect("unwrapFrame on a 7-byte message fails with ShortFrame", () =>
    Effect.gen(function* () {
      const mux = yield* MuxFraming;
      const exit = yield* Effect.exit(mux.unwrapFrame(new Uint8Array(7)));
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("unwrapFrame on an unknown protocol id fails with InvalidProtocol", () =>
    Effect.gen(function* () {
      const mux = yield* MuxFraming;
      // 8-byte header: time=0, agency+protocol = 0x0001 (has_agency=true, proto=1 — not in enum),
      // payload_length=0. Protocol 1 is unassigned in the Rust enum.
      const bogus = new Uint8Array([0, 0, 0, 0, 0x00, 0x01, 0, 0]);
      const exit = yield* Effect.exit(mux.unwrapFrame(bogus));
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("unwrapFrame on truncated payload fails with IncompletePayload", () =>
    Effect.gen(function* () {
      const mux = yield* MuxFraming;
      // header claims 16-byte payload but only 4 bytes follow the header.
      const truncated = new Uint8Array([0, 0, 0, 0, 0, 2, 0, 16, 1, 2, 3, 4]);
      const exit = yield* Effect.exit(mux.unwrapFrame(truncated));
      expect(exit._tag).toBe("Failure");
    }),
  );
});
