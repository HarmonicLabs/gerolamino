/**
 * Chrome extension RPC endpoints.
 *
 * The wire format mirrors `apps/tui`'s HTTP+WS protocol: the SW publishes
 * a JSON delta string per atom-registry change (shared encoder lives in
 * `dashboard/src/delta.ts`), and the popup decodes via the matching
 * `applyDelta` on its own mirror registry. Two endpoints:
 *
 *   - `BroadcastDeltas` — streaming. Each subscriber gets the current
 *     snapshot once (`Stream.concat(initial, …)`) followed by every
 *     subsequent published delta. Replaces the prior
 *     `chrome.storage.session.onChanged` bridge + per-field translator.
 *   - `StartSync` — control: kicks the bootstrap pipeline (currently
 *     auto-starts on SW boot too; this endpoint exists for a future
 *     "Start Sync" button on the popup).
 */
import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

/** Streaming endpoint: emits JSON delta strings produced by
 *  `buildDeltaJson` in the dashboard package. */
class BroadcastDeltas extends Rpc.make("BroadcastDeltas", {
  success: Schema.String,
  stream: true,
}) {}

/** Control endpoint: forces a bootstrap-sync restart. */
class StartSync extends Rpc.make("StartSync", {
  success: Schema.Struct({ ok: Schema.Boolean }),
}) {}

/** All RPC endpoints. Background SW implements the server; popup
 *  implements the client. */
export const NodeRpcs = RpcGroup.make(BroadcastDeltas, StartSync);
