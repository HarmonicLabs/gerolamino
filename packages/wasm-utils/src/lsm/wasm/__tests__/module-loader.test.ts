/**
 * Unit tests for the `lsm-wasm` adapter — exercises every typed error
 * path on `LsmWasmError.operation` without needing a real WASM runtime.
 *
 * The full end-to-end smoke against the compiled reactor module runs
 * via `haskell/lsm-tree-wasm-shim/test-node-import.mjs` (Node, not
 * Bun — Bun's `node:wasi` doesn't yet expose `initialize` for
 * reactor-mode modules). These vitest tests pin the failure-surface
 * contract so refactors of the loader can't silently degrade it.
 */
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { LsmWasmError } from "../errors.ts";
import { loadLsmModule, type WasiAdapter } from "../module-loader.ts";

/** A WASI adapter stub. Never reached in the failure tests below — the
 *  loader bails at compile / instantiate before initialize is called. */
const noopWasi: WasiAdapter = {
  wasiImport: {},
  initialize: () => undefined,
};

/** Extract the failing `LsmWasmError.operation` from an `Exit` produced
 *  by a `loadLsmModule` invocation. Returns `undefined` for a success
 *  exit so callers can `toBe("compile")` instead of nesting `if`s. */
const failureOp = (exit: Exit.Exit<unknown, LsmWasmError>): LsmWasmError["operation"] | undefined =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.operation
    : undefined;

describe("loadLsmModule — typed error surface", () => {
  it.effect("invalid magic bytes fail with operation=compile", () =>
    Effect.gen(function* () {
      // Bytes that are *not* a valid WASM module — the 4-byte magic
      // word must be `00 61 73 6d`; anything else fails compile.
      const garbageBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x00, 0x00]);
      const exit = yield* Effect.exit(
        loadLsmModule({
          wasmBytes: garbageBytes,
          jsffiFactory: () => ({}),
          wasi: noopWasi,
        }),
      );
      expect(failureOp(exit)).toBe("compile");
    }),
  );

  it.effect("truncated WASM header fails with operation=compile", () =>
    Effect.gen(function* () {
      // Valid magic word + version, but no sections — truncated.
      const truncated = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xff]);
      const exit = yield* Effect.exit(
        loadLsmModule({
          wasmBytes: truncated,
          jsffiFactory: () => ({}),
          wasi: noopWasi,
        }),
      );
      expect(failureOp(exit)).toBe("compile");
    }),
  );

  it.effect("empty WASM bytes fail with operation=compile", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        loadLsmModule({
          wasmBytes: new Uint8Array(0),
          jsffiFactory: () => ({}),
          wasi: noopWasi,
        }),
      );
      expect(failureOp(exit)).toBe("compile");
    }),
  );
});

describe("LsmWasmError", () => {
  it("constructs with every known operation literal", () => {
    // Pin every `operation` literal as part of the tagged error's
    // public contract. If a new operation literal lands without
    // updating the union, this test fails the boundary check.
    const ops = [
      "compile",
      "instantiate",
      "wasiInitialize",
      "hsInit",
      "exportMissing",
      "stringMarshal",
      "reactorCall",
    ] as const;
    for (const op of ops) {
      const err = new LsmWasmError({ operation: op, cause: new Error("test") });
      expect(err._tag).toBe("lsm-wasm/LsmWasmError");
      expect(err.operation).toBe(op);
    }
  });
});
