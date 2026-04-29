/**
 * Dashboard — top-level dashboard component, host-agnostic.
 *
 * Renders the new `Layout` primitive (3-panel resizable on wide hosts,
 * Tabs fallback on narrow popups via `@solid-primitives/resize-observer`):
 *
 *   ┌───────────┬─────────────────────────┬──────────────┐
 *   │   Sync    │  Peers / Mempool tabs    │ Chain events │
 *   │ overview  │       (TanStack table)   │  (LogRow)    │
 *   └───────────┴─────────────────────────┴──────────────┘
 *
 * In the chrome-ext popup (~380px) the Tabs fallback always engages, so
 * users see one panel at a time keyed off three top-level tabs. The
 * center panel keeps an inner `Tabs` for the Peers ↔ Mempool toggle so
 * both surfaces stay one click apart regardless of viewport.
 */
import { createSignal, Match, Switch } from "solid-js";
import { usePrimitives } from "../primitives.ts";
import { SyncOverview } from "./SyncOverview.tsx";
import { PeerTable } from "./PeerTable.tsx";
import { MempoolTable } from "./MempoolTable.tsx";
import { ChainEventLog } from "./ChainEventLog.tsx";
import { NetworkPanel } from "./NetworkPanel.tsx";

const CENTER_TABS = [
  { label: "Peers", value: "peers" },
  { label: "Mempool", value: "mempool" },
] as const;

export const Dashboard = () => {
  const { Layout, Tabs, Box } = usePrimitives();
  const [centerTab, setCenterTab] = createSignal<"peers" | "mempool">("peers");

  return (
    <Layout
      leftLabel="Sync"
      centerLabel="Activity"
      rightLabel="Events"
      // Left panel stacks the live sync overview above the static network
      // config card so chain progress and connection details share one
      // viewport — `NetworkPanel` was previously exported but unmounted.
      left={
        <Box direction="column" gap={2}>
          <SyncOverview />
          <NetworkPanel />
        </Box>
      }
      center={
        <Tabs tabs={CENTER_TABS} selected={centerTab()} onSelect={setCenterTab}>
          <Switch>
            <Match when={centerTab() === "peers"}>
              <PeerTable />
            </Match>
            <Match when={centerTab() === "mempool"}>
              <MempoolTable />
            </Match>
          </Switch>
        </Tabs>
      }
      right={<ChainEventLog />}
    />
  );
};
