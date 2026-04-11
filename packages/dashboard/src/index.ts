/**
 * packages/dashboard — shared dashboard for Gerolamino node.
 *
 * Works in both OpenTUI (apps/tui) and Chrome extension (packages/chrome-ext).
 * UI rendering is abstracted via DashboardPrimitives context — each platform
 * provides its own implementation.
 *
 * State management uses Effect Atoms (effect/unstable/reactivity) consumed
 * by SolidJS via @effect/atom-solid hooks.
 */

// Atoms (reactive state)
export {
  nodeStateAtom,
  peersAtom,
  bootstrapAtom,
  networkInfoAtom,
  isSyncingAtom,
  slotsBehindAtom,
  syncPercentLabelAtom,
  INITIAL_NODE_STATE,
  INITIAL_BOOTSTRAP,
  INITIAL_NETWORK,
  NodeState,
  SyncStatus,
  GsmState,
  PeerInfo,
  PeerInfoStatus,
  BootstrapProgress,
  BootstrapPhase,
  NetworkInfo,
  NetworkName,
} from "./atoms";

// Primitives (platform abstraction)
export { PrimitivesProvider, usePrimitives } from "./primitives.ts";
export type {
  DashboardPrimitives,
  BoxProps,
  TextProps,
  BadgeProps,
  ProgressProps,
  CardProps,
  StatProps,
  TabsProps,
  TableColumn,
  TableProps,
  ScrollAreaProps,
  SeparatorProps,
} from "./primitives.ts";

// Components
export { Dashboard, SyncOverview, PeerTable, NetworkPanel } from "./components";
