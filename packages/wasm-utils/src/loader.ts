/**
 * Cross-runtime WASM byte-loader service.
 *
 * Single abstraction over the three WASM modules this codebase
 * consumes (`wasm_utils_bg.wasm` for crypto, `wasm_plexer_bg.wasm`
 * for the multiplexer, `lsm-tree-wasm.wasm` for the LSM-tree shim).
 * Two runtimes (TUI = Bun, chrome-ext = browser) each provide their
 * own Layer; everything downstream consumes the unified `WasmBytes`
 * service.
 *
 * Why a service rather than per-module `import` magic: wasm-bindgen's
 * default init reaches for `import.meta.url`-relative paths, which
 * works for the chrome-ext WXT bundle but skips for the TUI's Bun
 * entrypoint when WASM lives in a Nix store path injected via env.
 * One service unifies that.
 *
 * Per the platform-unification plan (memory
 * `project_effect_platform_unification_plan.md`), all three modules
 * route through this loader. Adapters:
 *   - `WasmBytesFsLayer` — Effect's `FileSystem` service + a configured
 *     root directory. Used by the TUI; the WASM dir gets injected via
 *     `GEROLAMINO_WASM_DIR` (defaults to the package's `pkg/`).
 *   - `WasmBytesUrlLayer` — `import.meta.url`-relative URLs. Used by
 *     the chrome-ext WXT bundle where each `.wasm` is a separate
 *     emitted asset addressable via `new URL("./foo.wasm", import.meta.url)`.
 */
import { Context, Data, Effect, Layer } from "effect";
import * as FileSystem from "effect/FileSystem";

/**
 * Typed load error. Carries the module name + the underlying cause
 * so consumers can surface a precise message ("crypto WASM failed:
 * ENOENT /nix/store/…").
 */
export class WasmLoadError extends Data.TaggedError("wasm-utils/WasmLoadError")<{
  readonly name: string;
  readonly cause: unknown;
}> {}

/**
 * Service tag — `yield* WasmBytes` from any consumer and call
 * `load(name)` with one of the canonical names:
 *   - `wasm-utils`  → wasm-bindgen crypto bundle
 *   - `wasm-plexer` → multiplexer bundle
 *   - `lsm-tree`    → Haskell→WASM lsm-tree shim
 *
 * The mapping name → on-disk file is the adapter's responsibility;
 * keeping the consumer-facing API name-keyed lets each runtime
 * normalize paths/URLs without affecting downstream code.
 */
export class WasmBytes extends Context.Service<WasmBytes, {
  readonly load: (name: string) => Effect.Effect<Uint8Array, WasmLoadError>;
}>()("wasm-utils/WasmBytes") {}

/**
 * Filesystem-backed adapter — for the Bun TUI. Resolves
 * `<root>/<name>.wasm` via Effect's `FileSystem` service (provided
 * by `BunFileSystem.layer` at the entrypoint).
 *
 * Default `root`: the wasm-utils package's `pkg/` directory, which is
 * where `nix build .#wasm-utils` + symlinks injected via `link-wasm`
 * place the artefacts. Override via env or by passing a different
 * root to the factory.
 */
export const WasmBytesFsLayer = (root: string) =>
  Layer.effect(WasmBytes)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return {
        load: (name) =>
          fs
            .readFile(`${root}/${name}.wasm`)
            .pipe(Effect.mapError((cause) => new WasmLoadError({ name, cause }))),
      };
    }),
  );

/**
 * URL-keyed adapter — for the chrome-ext browser bundle. Each WASM
 * module is emitted as a separate asset by Vite/Rolldown; the
 * caller passes a name → URL map (typically built from
 * `new URL("./foo.wasm", import.meta.url)` lookups at the
 * entrypoint).
 *
 * Fetches via the runtime `fetch` global (works in
 * dedicated/shared/service workers + offscreen documents).
 */
export const WasmBytesUrlLayer = (urls: Record<string, URL>) =>
  Layer.succeed(WasmBytes)({
    load: (name) => {
      const url = urls[name];
      if (url === undefined) {
        return Effect.fail(
          new WasmLoadError({
            name,
            cause: `no URL registered for "${name}" — provide via WasmBytesUrlLayer({ [name]: url })`,
          }),
        );
      }
      return Effect.tryPromise({
        try: () =>
          fetch(url)
            .then((r) => r.arrayBuffer())
            .then((b) => new Uint8Array(b)),
        catch: (cause) => new WasmLoadError({ name, cause }),
      });
    },
  });
