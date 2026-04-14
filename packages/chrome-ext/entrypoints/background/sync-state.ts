/**
 * SyncStateRef — shared mutable state for the background service worker.
 *
 * Used by both the RPC handlers and the bootstrap sync pipeline to ensure
 * sync progress reaches the popup via RPC streaming AND chrome.storage.session
 * (for non-RPC consumers).
 *
 * Uses Effect PubSub for subscriber management — subscribers are automatically
 * cleaned up when their scope exits (popup disconnects).
 */
import { Clock, Context, Effect, Layer, PubSub, Ref, Stream } from "effect";
import { SyncState, INITIAL_STATE } from "./rpc.ts";

export class SyncStateRef extends Context.Service<
  SyncStateRef,
  {
    /** Get current sync state. */
    readonly get: Effect.Effect<SyncState>;
    /** Update state and notify all streaming subscribers + chrome.storage.session. */
    readonly update: (patch: Partial<SyncState>) => Effect.Effect<void>;
    /** Stream of state updates — starts with current state, then pushes changes. */
    readonly subscribe: Stream.Stream<SyncState>;
  }
>()("@gerolamino/chrome-ext/SyncStateRef") {
  static readonly Live = Layer.effect(
    SyncStateRef,
    Effect.gen(function* () {
      const stateRef = yield* Ref.make<SyncState>(INITIAL_STATE);
      const pubsub = yield* PubSub.unbounded<SyncState>();

      const update = (patch: Partial<SyncState>) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(stateRef);
          const now = yield* Clock.currentTimeMillis;
          const next = new SyncState({ ...current, ...patch, lastUpdated: now });
          yield* Ref.set(stateRef, next);

          // Log status transitions so the entire sync lifecycle is traceable
          // from a single point. Non-status patches are not logged here to
          // keep the signal high (per-field progress is logged by the callers).
          if (patch.status !== undefined && patch.status !== current.status) {
            if (patch.status === "error") {
              yield* Effect.logError(
                `[sync-state] ${current.status} → error: ${patch.lastError ?? "unknown"}`,
              );
            } else {
              yield* Effect.log(`[sync-state] ${current.status} → ${patch.status}`);
            }
          }

          // Push to all streaming subscribers via PubSub (auto-cleaned on scope exit)
          yield* PubSub.publish(pubsub, next);

          // Also persist to chrome.storage.session for non-RPC consumers
          yield* Effect.promise(() => globalThis.chrome.storage.session.set({ syncState: next }));
        });

      // Stream: emit current state first, then all subsequent PubSub updates
      const subscribe: Stream.Stream<SyncState> = Stream.concat(
        Stream.fromEffect(Ref.get(stateRef)),
        Stream.fromPubSub(pubsub),
      );

      return SyncStateRef.of({
        get: Ref.get(stateRef),
        update,
        subscribe,
      });
    }),
  );
}
