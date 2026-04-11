/**
 * TUI Dashboard — renders the shared dashboard using OpenTUI.
 *
 * Provides:
 * 1. AtomRegistry (Effect Atoms → SolidJS reactivity bridge)
 * 2. TUI DashboardPrimitives (OpenTUI constructs)
 * 3. Dashboard component from packages/dashboard
 *
 * Atom push functions are in atoms.ts (plain TS, no JSX) so the main
 * entry point can import them without triggering Solid.js JSX compilation.
 */
import { RegistryProvider } from "@effect/atom-solid";
import { PrimitivesProvider, Dashboard } from "dashboard";
import { registry } from "./atoms.ts";
import { tuiPrimitives } from "./tui-primitives.tsx";

/** Top-level TUI dashboard component. */
export const TuiDashboard = () => (
  <RegistryProvider registry={registry}>
    <PrimitivesProvider value={tuiPrimitives}>
      <Dashboard />
    </PrimitivesProvider>
  </RegistryProvider>
);

// Re-export atom push functions for convenience
export {
  registry,
  pushNodeState,
  pushBootstrapProgress,
  pushNetworkInfo,
  pushPeers,
} from "./atoms.ts";
