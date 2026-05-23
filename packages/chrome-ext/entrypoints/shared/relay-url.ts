/**
 * Build-time relay-proxy base URL (`BOOTSTRAP_URL` env at `wxt build`).
 * Used by setup form defaults and offscreen bootstrap-sync fallbacks.
 */
declare const __BOOTSTRAP_URL__: string;

export const DEFAULT_RELAY_URL: string = __BOOTSTRAP_URL__;
