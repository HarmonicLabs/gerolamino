/**
 * In-memory `KeyValueStore` layer for hermetic popup tests.
 */
import { Effect, Layer } from "effect";
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore";

export const InMemoryKeyValueStoreLayer: Layer.Layer<KeyValueStore.KeyValueStore> =
  KeyValueStore.layerMemory;

/** Seed bootstrap settings as the production JSON-string envelope. */
export const seedBootstrapSettingsJson = (
  settings: { readonly mode: "local" | "genesis"; readonly serverUrl: string },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const kv = yield* KeyValueStore.KeyValueStore;
    const encoded = yield* Effect.sync(() => JSON.stringify(settings));
    yield* kv.set("gerolamino:bootstrap-settings", encoded);
  }).pipe(Effect.provide(InMemoryKeyValueStoreLayer));
