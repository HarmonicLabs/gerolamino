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
  // Existing
  nodeStateAtom,
  peersAtom,
  bootstrapAtom,
  networkInfoAtom,
  isSyncingAtom,
  slotsBehindAtom,
  syncPercentLabelAtom,
  // New (this wave)
  mempoolSnapshotAtom,
  mempoolSizeAtom,
  mempoolFeeP50Atom,
  chainEventLogAtom,
  syncSparklineAtom,
  // Constants
  INITIAL_NODE_STATE,
  INITIAL_BOOTSTRAP,
  INITIAL_NETWORK,
  CHAIN_EVENT_LOG_CAP,
  SYNC_SPARKLINE_CAP,
  // Push helpers
  pushMempoolSnapshot,
  pushChainEventLog,
  appendChainEvent,
  pushSyncSparklinePoint,
  // Schemas / types
  NodeState,
  SyncStatus,
  GsmState,
  PeerInfo,
  PeerInfoStatus,
  BootstrapProgress,
  BootstrapPhase,
  NetworkInfo,
  NetworkName,
  MempoolEntry,
  ChainEventEntry,
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
  // New (this wave)
  LayoutProps,
  TooltipProps,
  IconButtonProps,
  SparklineProps,
  LogRowProps,
} from "./primitives.ts";

// DOM-host primitive factory — shared between apps/tui Bun.WebView host
// (Phase E, deferred) and packages/chrome-ext popup. Each call returns
// a fresh `DashboardPrimitives` record over Tailwind v4 + Kobalte + Corvu.
export { createDomPrimitives } from "./primitives/dom";

// Components
export {
  Dashboard,
  SyncOverview,
  PeerTable,
  NetworkPanel,
  MempoolTable,
  ChainEventLog,
} from "./components";
