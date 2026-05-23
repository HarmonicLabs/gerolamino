/**
 * Effect `Config` gates for WASM lsm-tree tests.
 */
import { Config, Effect } from "effect";

/** Gate WASM reactor tests that need Bun's full WASI runtime. */
export const LsmWasmBunRuntimeTests = Config.string("LSM_WASM_BUN_RUNTIME_TESTS").pipe(
  Config.withDefault(""),
  Config.map((v) => v === "1"),
);

export const mithrilFixtureEnabled = Config.string("MITHRIL_FIXTURE_ENABLED").pipe(
  Config.withDefault("false"),
  Config.map((v) => v === "true"),
);

export const MithrilFixturePath = Config.string("MITHRIL_FIXTURE_PATH").pipe(
  Config.withDefault("./mithril-fixture"),
);

export const skipUnlessMithrilFixture = Effect.gen(function* () {
  const enabled = yield* mithrilFixtureEnabled;
  return !enabled;
});
