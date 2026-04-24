/**
 * TUI Dashboard atom-push re-exports.
 *
 * The live-rendering TUI (`TuiDashboard` Solid component + OpenTUI
 * primitives) was removed alongside the OpenTUI dependency — the
 * replacement lives in Phase 5 (Bun.WebView + `packages/dashboard` DOM
 * adapter). Until that phase lands, the TUI node renders nothing; atom
 * state is exposed via log lines in `apps/tui/src/index.ts`.
 *
 * This file stays as a barrel for the atom-push helpers — deleting the
 * `./atoms.ts` re-export path would churn `apps/tui/src/index.ts` with
 * unrelated imports, so we keep the indirection.
 */
export {
  registry,
  pushNodeState,
  pushBootstrapProgress,
  pushNetworkInfo,
  pushPeers,
} from "./atoms.ts";
