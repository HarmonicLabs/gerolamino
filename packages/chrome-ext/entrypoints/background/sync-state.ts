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
import { Clock, Effect, Layer, PubSub, Queue, Ref, ServiceMap } from "effect";
import { SyncState, INITIAL_STATE } from "./rpc.ts";

export class SyncStateRef extends ServiceMap.Service<
  SyncStateRef,
  {
    /** Get current sync state. */
    readonly get: Effect.Effect<SyncState>;
    /** Update state and notify all streaming subscribers + chrome.storage.session. */
    readonly update: (patch: Partial<SyncState>) => Effect.Effect<void>;
    /** Create a subscriber Queue for StreamSyncState (auto-cleaned on scope exit). */
    readonly subscribe: Effect.Effect<Queue.Queue<SyncState>>;
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

          // Push to all streaming subscribers via PubSub (auto-cleaned on scope exit)
          yield* PubSub.publish(pubsub, next);

          // Also persist to chrome.storage.session for non-RPC consumers
          yield* Effect.promise(() => globalThis.chrome.storage.session.set({ syncState: next }));
        });

      const subscribe: Effect.Effect<Queue.Queue<SyncState>> = Effect.gen(function* () {
        // PubSub.subscribe returns a scoped Queue that auto-unsubscribes on scope exit
        const mailbox = yield* PubSub.subscribe(pubsub);

        // Push current state immediately so subscriber gets initial value
        const current = yield* Ref.get(stateRef);
        yield* Queue.offer(mailbox, current);

        return mailbox;
      });

      return SyncStateRef.of({
        get: Ref.get(stateRef),
        update,
        subscribe,
      });
    }),
  );
}
