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
import {
  PrimitivesProvider,
  Dashboard,
  nodeStateAtom,
  bootstrapAtom,
  peersAtom,
  networkInfoAtom,
} from "dashboard";
import type { NodeState, BootstrapProgress, NetworkInfo } from "dashboard";
import { SyncState } from "../../background/rpc.ts";
import { browserPrimitives } from "./browser-primitives.tsx";

/** Create a shared AtomRegistry for the popup. */
const registry = AtomRegistry.make();

const decodeSyncState = Schema.decodeUnknownOption(SyncState);

/*
 * `mapPeerStatus` has been removed: the wire-side `SyncState.peers[].status`
 * is already narrowed to `PeerInfoStatus` (the canonical 5-state enum from
 * consensus/rpc — see `packages/chrome-ext/entrypoints/background/rpc.ts`).
 * The popup now forwards the status through unchanged.
 */

/** Map SyncState from chrome.storage → dashboard atoms. */
const pushSyncState = (s: SyncState) => {
  // Node state — handle all 6 status values + relay fields (spread to avoid readonly mutation)
  registry.update(nodeStateAtom, (prev) => ({
    ...prev,
    status: s.status,
    lastError: s.lastError,
    lastUpdated: s.lastUpdated,
    ...(s.tipSlot !== undefined ? { tipSlot: BigInt(s.tipSlot) } : {}),
    ...(s.currentSlot !== undefined ? { currentSlot: BigInt(s.currentSlot) } : {}),
    ...(s.epochNumber !== undefined ? { epochNumber: BigInt(s.epochNumber) } : {}),
    ...(s.syncPercent !== undefined ? { syncPercent: s.syncPercent } : {}),
    ...(s.gsmState !== undefined
      ? {
          gsmState:
            s.gsmState === "CaughtUp"
              ? ("CaughtUp" as const)
              : s.gsmState === "PreSyncing"
                ? ("PreSyncing" as const)
                : ("Syncing" as const),
        }
      : {}),
    blocksProcessed: s.blocksProcessed !== undefined ? s.blocksProcessed : s.blocksReceived,
  }));

  // Bootstrap progress — phase is server-driven (set by background during each
  // transition). Optional totals are forwarded only when present.
  registry.update(bootstrapAtom, (prev) => ({
    ...prev,
    phase: s.bootstrapPhase,
    protocolMagic: s.protocolMagic,
    snapshotSlot: s.snapshotSlot,
    totalChunks: s.totalChunks,
    totalBlobEntries: s.totalBlobEntries,
    blobEntriesReceived: s.blobEntriesReceived,
    blocksReceived: s.blocksReceived,
    ledgerStateReceived: s.ledgerStateReceived,
    ledgerStateDecoded: s.ledgerStateDecoded,
    accountsWritten: s.accountsWritten,
    stakeEntriesWritten: s.stakeEntriesWritten,
    ...(s.totalAccounts !== undefined ? { totalAccounts: s.totalAccounts } : {}),
    ...(s.totalStakeEntries !== undefined ? { totalStakeEntries: s.totalStakeEntries } : {}),
  }));

  // Peers — map string tipSlot → bigint and synthesize address from id.
  // The background-side `SyncState.peers[].status` is already narrowed to
  // `PeerInfoStatus` (canonical 5-state), so we forward it unchanged.
  if (s.peers !== undefined) {
    registry.update(peersAtom, () =>
      s.peers!.map((p) => ({
        id: p.id,
        address: p.id,
        status: p.status,
        tipSlot: BigInt(p.tipSlot),
      })),
    );
  }

  // Network info
  if (s.network !== undefined) {
    registry.update(networkInfoAtom, (prev) => ({
      ...prev,
      network:
        s.network === "mainnet"
          ? ("mainnet" as const)
          : s.network === "preview"
            ? ("preview" as const)
            : ("preprod" as const),
      protocolMagic: s.protocolMagic,
      ...(s.relayHost !== undefined ? { relayHost: s.relayHost } : {}),
      ...(s.relayPort !== undefined ? { relayPort: s.relayPort } : {}),
    }));
  }
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
