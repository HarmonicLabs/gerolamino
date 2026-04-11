/**
 * Browser Dashboard — renders the shared dashboard in the Chrome extension popup.
 *
 * Provides:
 * 1. AtomRegistry (Effect Atoms → SolidJS reactivity bridge)
 * 2. Browser DashboardPrimitives (HTML elements + inline styles)
 * 3. Dashboard component from packages/dashboard
 *
 * Bridges sync state from the background service worker into Effect Atoms
 * via chrome.storage.onChanged listener (event-driven, instant updates).
 */
import { createEffect, onCleanup } from "solid-js";
import { AtomRegistry } from "effect/unstable/reactivity";
import { RegistryContext } from "@effect/atom-solid";
import { Option, Schema } from "effect";
import { PrimitivesProvider, Dashboard, nodeStateAtom, bootstrapAtom } from "dashboard";
import type { NodeState, BootstrapProgress } from "dashboard";
import { SyncState } from "../../background/rpc.ts";
import { browserPrimitives } from "./browser-primitives.tsx";

/** Create a shared AtomRegistry for the popup. */
const registry = AtomRegistry.make();

const decodeSyncState = Schema.decodeUnknownOption(SyncState);

/** Map SyncState from chrome.storage → dashboard atoms. */
const pushSyncState = (s: SyncState) => {
  const nodeUpdate: Partial<NodeState> = {
    status:
      s.status === "bootstrapping"
        ? "bootstrapping"
        : s.status === "syncing"
          ? "syncing"
          : s.status === "connecting"
            ? "connecting"
            : s.status === "error"
              ? "error"
              : "idle",
    blocksProcessed: s.blocksReceived,
    lastError: s.lastError,
    lastUpdated: s.lastUpdated,
  };
  registry.update(nodeStateAtom, (prev) => ({ ...prev, ...nodeUpdate }));

  const bootstrapUpdate: Partial<BootstrapProgress> = {
    phase: s.bootstrapComplete
      ? "complete"
      : s.ledgerStateReceived
        ? "blocks"
        : s.blobEntriesReceived > 0
          ? "utxo-entries"
          : s.status === "bootstrapping"
            ? "ledger-state"
            : "idle",
    protocolMagic: s.protocolMagic,
    snapshotSlot: s.snapshotSlot,
    totalChunks: s.totalChunks,
    totalBlobEntries: s.totalBlobEntries,
    blobEntriesReceived: s.blobEntriesReceived,
    blocksReceived: s.blocksReceived,
    ledgerStateReceived: s.ledgerStateReceived,
  };
  registry.update(bootstrapAtom, (prev) => ({ ...prev, ...bootstrapUpdate }));
};

/**
 * State bridge — listens for chrome.storage.session changes from background.
 *
 * Uses chrome.storage.onChanged for instant, event-driven updates.
 * Also loads initial state on mount. No Effect fibers or RPC needed —
 * the background already persists every state update to chrome.storage.session.
 */
const StorageBridge = () => {
  createEffect(() => {
    // Event-driven: fires whenever background calls chrome.storage.session.set()
    const onChange = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area !== "session" || !changes.syncState) return;
      const parsed = decodeSyncState(changes.syncState.newValue);
      if (Option.isSome(parsed)) {
        pushSyncState(parsed.value);
      }
    };
    chrome.storage.onChanged.addListener(onChange);

    // Initial load — pick up whatever state the background has stored so far
    chrome.storage.session.get("syncState").then((result) => {
      const parsed = decodeSyncState(result.syncState);
      if (Option.isSome(parsed)) {
        pushSyncState(parsed.value);
      }
    });

    onCleanup(() => chrome.storage.onChanged.removeListener(onChange));
  });

  return null;
};

/** Top-level browser dashboard for the popup. */
export const BrowserDashboard = () => (
  <RegistryContext.Provider value={registry}>
    <PrimitivesProvider value={browserPrimitives}>
      <StorageBridge />
      <div
        style={{
          width: "380px",
          "min-height": "480px",
          padding: "16px",
          "background-color": "#0f172a",
          color: "#e5e7eb",
          "font-family": "'Inter', system-ui, sans-serif",
        }}
      >
        <Dashboard />
      </div>
    </PrimitivesProvider>
  </RegistryContext.Provider>
);
