/**
 * Bun-compatible `WasiAdapter` factory.
 *
 * Bun ≤ 1.3.14's `node:wasi` exposes `start(instance, memory)` for
 * command-mode modules but NOT `initialize(instance, memory)` for
 * reactor-mode modules. The upstream fix is on Bun's
 * `claude/fix-wasi-initialize-12755` branch and adds the missing
 * method. Until that lands in a release, this module polyfills
 * `initialize` against Bun's existing WASI runtime.
 *
 * Polyfill logic (mirrors the upstream patch verbatim):
 *   1. If `instance.exports.memory` is a `WebAssembly.Memory`, attach
 *      it via `wasi.setMemory(memory)`.
 *   2. Refuse to initialise a module that also exports `_start` —
 *      reactor vs command is mutually exclusive.
 *   3. Call `instance.exports._initialize()` if present (this is
 *      ghc-wasm-meta's reactor entrypoint).
 *
 * Drop this file entirely once Bun ≥ 1.4 ships the fix.
 */
import { WASI as NodeWASI } from "node:wasi";
import { LsmWasmError } from "./errors.ts";
import type { WasiAdapter } from "./module-loader.ts";

/** Subset of Bun's `node:wasi` WASI shape that the polyfill touches.
 *  Declared inline because Bun's types don't expose `setMemory` and
 *  `initialize` differs from Node's published types. */
interface BunWasiInternals {
  wasiImport: WebAssembly.ModuleImports;
  initialize?: (instance: WebAssembly.Instance, memory?: WebAssembly.Memory) => void;
  setMemory?: (memory: WebAssembly.Memory) => void;
}

/** Patch a `node:wasi` instance in place so `initialize` works for
 *  reactor modules. Idempotent: if `wasi.initialize` already exists
 *  (post-Bun-1.4), the polyfill is a no-op. */
const polyfillInitialize = (wasi: BunWasiInternals): void => {
  if (typeof wasi.initialize === "function") return;
  wasi.initialize = (instance, memory) => {
    if (
      memory === undefined &&
      instance.exports.memory instanceof WebAssembly.Memory
    ) {
      memory = instance.exports.memory;
    }
    if (memory !== undefined && typeof wasi.setMemory === "function") {
      wasi.setMemory(memory);
    }
    // Reactor modules must NOT also export `_start` — that's command
    // mode. Refuse to mix the two so a misconfigured shim fails loud
    // rather than running `_start` and `_initialize` both.
    const start = instance.exports._start;
    if (typeof start === "function") {
      throw new LsmWasmError({
        operation: "wasiInitialize",
        cause:
          "WasiAdapter.initialize: instance exports `_start`; this is a " +
          "command-mode module — use `WASI.start()` instead.",
      });
    }
    const init = instance.exports._initialize;
    if (typeof init === "function") {
      init();
    }
  };
};

export interface BunWasiOptions {
  /** Host filesystem mountpoint(s) for the WASI sandbox. Default
   *  `{ "/": process.cwd() }` makes the current working directory
   *  the WASM root. For the TUI's lsm-tree data directory, pass
   *  `{ "/data": dataDir }` (or `{ "/": "/" }` to mirror the
   *  test-driver setup). */
  readonly preopens?: Readonly<Record<string, string>>;
  /** Argv passed to the reactor module. Required (even if empty) by
   *  Node's WASI; defaults to `["lsm-tree-wasm"]`. */
  readonly args?: ReadonlyArray<string>;
  /** Env vars passed to the reactor module. Defaults to a minimal
   *  pair that keeps WASI happy without leaking host env. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Build a Bun-compatible `WasiAdapter` for the lsm-tree WASM shim.
 *
 * The returned adapter plugs directly into `loadLsmModule({ wasi })`.
 * Calling sites do not need to know about the polyfill — it's
 * applied transparently to the `node:wasi` instance the adapter
 * wraps.
 */
export const makeBunWasi = (options: BunWasiOptions = {}): WasiAdapter => {
  const wasi: BunWasiInternals = new NodeWASI({
    version: "preview1",
    args: options.args ? [...options.args] : ["lsm-tree-wasm"],
    env: options.env ? { ...options.env } : { PATH: "", PWD: process.cwd() },
    preopens: options.preopens ? { ...options.preopens } : { "/": process.cwd() },
  });
  polyfillInitialize(wasi);
  return {
    wasiImport: wasi.wasiImport,
    initialize: (instance) => {
      if (typeof wasi.initialize !== "function") {
        throw new LsmWasmError({
          operation: "wasiInitialize",
          cause:
            "makeBunWasi: polyfillInitialize failed to attach `initialize` " +
            "to the node:wasi instance. Check Bun version compatibility.",
        });
      }
      wasi.initialize(instance);
    },
  };
};
