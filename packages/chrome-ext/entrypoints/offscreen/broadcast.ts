/**
 * Offscreen-side broadcast PubSub + scoped fiber.
 *
 * Mirror of `entrypoints/background/dashboard/broadcast.ts` for the
 * offscreen daemon. The fiber polls the offscreen-local atom registry
 * every `DELTA_PUSH_INTERVAL_MS` (100 ms), runs identity-first dedup,
 * and publishes JSON deltas into the `OffscreenAtomBroadcast`
 * PubSub. The `SubscribeAtomDeltas` RPC handler in `main.ts` reads
 * from the same PubSub via `Stream.fromPubSub`, so each popup
 * subscriber (today via the SW relay, planned for stage 3c) sees a
 * deduped tap on the producer.
 *
 * `bootstrap-sync.ts` writes node/peers/bootstrap atoms; `ChainEventStream`
 * drain appends chain events; the broadcast fiber dedupes and publishes
 * JSON deltas for `SubscribeAtomDeltas` → popup `applyDelta`.
 */
import { Context, Effect, Layer, PubSub } from "effect";
import { makeBroadcastFiber } from "dashboard/broadcast";
import { registry } from "./atoms.ts";

/** Cadence of the producer loop. 100 ms (10 Hz) matches the SW
 *  broadcast fiber + the apps/tui WS host. */
export const DELTA_PUSH_INTERVAL_MS = 100;

/** Service tag for the offscreen-local delta PubSub. The
 *  `SubscribeAtomDeltas` handler depends on it; the broadcast fiber
 *  publishes into it. Distinct from the SW's `DashboardBroadcast`
 *  Service in `entrypoints/background/dashboard/broadcast.ts` —
 *  different process, different module-evaluation scope, no
 *  cross-context Service collision. */
export class OffscreenAtomBroadcast extends Context.Service<
  OffscreenAtomBroadcast,
  PubSub.PubSub<string>
>()("offscreen/AtomBroadcast") {
  static readonly Live = Layer.effect(
    OffscreenAtomBroadcast,
    PubSub.sliding<string>(256).pipe(
      // `sliding(256)`: drop the oldest delta when subscriber queues
      // fill — same backpressure policy as the SW's
      // DashboardBroadcast. Live state matters more than the event
      // that produced it; unbounded would let a stalled popup grow
      // per-subscriber buffers indefinitely while the offscreen heap
      // budget stays tight.
      Effect.tap((broadcast) =>
        Effect.forkScoped(makeBroadcastFiber(registry, broadcast, DELTA_PUSH_INTERVAL_MS)),
      ),
    ),
  );
}
