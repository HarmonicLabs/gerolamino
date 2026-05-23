/**
 * Upload RPC transport — popup → offscreen BroadcastChannel (never Port).
 *
 * Snapshot uploads run for tens of minutes. Routing through
 * `chrome.runtime.Port` → SW ties the upload to SW lifetime; MV3 SW sleep
 * disconnects the port (`RpcClientDefect: Chrome runtime port disconnected`).
 *
 * Production uses `clientId=2`; Playwright E2E uses `clientId=1` when
 * `__GEROLAMINO_E2E_DIRECT_OFFSCREEN_RPC__` is set (SW Port relay unreliable
 * in persistent context). Dashboard deltas still use Port → SW.
 */
import { Layer } from "effect";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { layerClientProtocolChromePort } from "../background/rpc-transport.ts";
import {
  layerClientProtocolBroadcastChannelE2e,
  layerClientProtocolBroadcastChannelPopup,
} from "../offscreen/rpc-transport.ts";

declare global {
  // eslint-disable-next-line no-var
  var __GEROLAMINO_E2E_DIRECT_OFFSCREEN_RPC__: boolean | undefined;
}

export const isE2eDirectOffscreenRpc = (): boolean =>
  globalThis.__GEROLAMINO_E2E_DIRECT_OFFSCREEN_RPC__ === true;

export const uploadRpcLayer = () =>
  isE2eDirectOffscreenRpc()
    ? Layer.merge(RpcSerialization.layerNdjson, layerClientProtocolBroadcastChannelE2e)
    : Layer.merge(RpcSerialization.layerNdjson, layerClientProtocolBroadcastChannelPopup);

/** Production popup → SW Port layer (setup submit, non-E2E paths). */
export const nodeRpcLayer = Layer.merge(
  RpcSerialization.layerNdjson,
  layerClientProtocolChromePort,
);
