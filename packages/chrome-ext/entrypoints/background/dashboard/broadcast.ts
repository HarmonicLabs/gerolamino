/**
 * broadcast.ts — atom-state delta broadcast for the chrome-ext SW.
 *
 * Mirrors `apps/tui/src/dashboard/serve.ts:82-95` exactly, minus the
 * HTTP/WS server (replaced by the chrome.runtime.Port-backed RPC stream
 * defined in `rpc-server.ts`):
 *
 *   1. Build a `PubSub<string>` that fans the single delta producer out
 *      to N concurrent RPC subscribers (one per popup connection).
 *   2. Fork a fiber that polls the dashboard atom registry on
 *      `DELTA_PUSH_INTERVAL_MS`, builds the JSON via `buildDeltaJson`
 *      (shared with apps/tui), dedups against the last published string,
 *      and publishes only when changed.
 *   3. Hand the PubSub back to the caller (the SW entry point) so the
 *      RPC server can `Stream.fromPubSub` on each `BroadcastDeltas` call.
 */
import { Context, Effect, Layer, PubSub, Ref, Schedule } from "effect";
import { buildDeltaJson } from "dashboard/delta";
import { registry } from "./atoms.ts";

/** Cadence of the delta-build/dedup/publish loop. 100 ms (10 Hz) is the
 *  same value the apps/tui server settled on — high enough to feel live,
 *  low enough that the JSON.stringify of the full atom tree doesn't
 *  contend with the rest of the SW's work. */
export const DELTA_PUSH_INTERVAL_MS = 100;

/** Service binding for the broadcast PubSub. The RPC handler depends on
 *  this Context; the SW entry provides it via the layer below. */
export class DashboardBroadcast extends Context.Service<
  DashboardBroadcast,
  PubSub.PubSub<string>
>()("@gerolamino/chrome-ext/DashboardBroadcast") {
  static readonly Live = Layer.effect(
    DashboardBroadcast,
    Effect.gen(function* () {
      // `sliding(256)` mirrors the broadcast strategy in
      // `consensus/src/peer/events.ts` — drop the oldest delta if a
      // subscriber's bounded queue fills, since "live" state is
      // monotonically more useful than the event that produced it.
      // Unbounded would let a slow popup grow per-subscriber buffers
      // indefinitely while the SW heap budget is tight.
      const broadcast = yield* PubSub.sliding<string>(256);
      yield* Effect.forkScoped(broadcastFiber(broadcast));
      return broadcast;
    }),
  );
}

const broadcastFiber = (broadcast: PubSub.PubSub<string>) =>
  Effect.gen(function* () {
    const lastJsonRef = yield* Ref.make("");
    yield* Effect.repeat(
      Effect.gen(function* () {
        const json = buildDeltaJson(registry);
        const last = yield* Ref.get(lastJsonRef);
        if (json === last) return;
        yield* Ref.set(lastJsonRef, json);
        yield* PubSub.publish(broadcast, json);
      }),
      Schedule.fixed(`${DELTA_PUSH_INTERVAL_MS} millis`),
    );
  });
