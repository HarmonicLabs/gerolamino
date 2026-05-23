/**
 * Bootstrap settings codec round-trip (in-memory KeyValueStore).
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  loadSettings,
  saveSettings,
} from "../../entrypoints/shared/bootstrap-settings.ts";
import { InMemoryKeyValueStoreLayer, seedBootstrapSettingsJson } from "./helpers/in-memory-kv.ts";

describe("bootstrap-settings", () => {
  it.effect("round-trips genesis settings through KeyValueStore", () =>
    Effect.gen(function* () {
      yield* saveSettings({ mode: "genesis", serverUrl: "ws://localhost:3040" });
      const loaded = yield* loadSettings;
      assert.deepStrictEqual(loaded, { mode: "genesis", serverUrl: "ws://localhost:3040" });
    }).pipe(Effect.provide(InMemoryKeyValueStoreLayer)),
  );

  it.effect("returns undefined when key is absent", () =>
    Effect.gen(function* () {
      const loaded = yield* loadSettings;
      assert.strictEqual(loaded, undefined);
    }).pipe(Effect.provide(InMemoryKeyValueStoreLayer)),
  );

  it.effect("seed helper writes the Playwright storage key", () =>
    Effect.gen(function* () {
      yield* seedBootstrapSettingsJson({ mode: "local", serverUrl: "ws://127.0.0.1:3040" });
      const loaded = yield* loadSettings;
      assert.strictEqual(loaded?.mode, "local");
      assert.strictEqual(loaded?.serverUrl, "ws://127.0.0.1:3040");
    }).pipe(Effect.provide(InMemoryKeyValueStoreLayer)),
  );
});
