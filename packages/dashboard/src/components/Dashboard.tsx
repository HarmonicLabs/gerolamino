/**
 * Dashboard — top-level dashboard component with tabbed navigation.
 * Platform-agnostic: renders via DashboardPrimitives context.
 *
 * Tabs:
 * 1. Overview — sync status, progress, bootstrap
 * 2. Peers — connected peer table
 * 3. Network — network config and GSM state
 */
import { createSignal } from "solid-js";
import { Match, Switch } from "solid-js";
import { usePrimitives } from "../primitives.ts";
import { SyncOverview } from "./SyncOverview.tsx";
import { PeerTable } from "./PeerTable.tsx";
import { NetworkPanel } from "./NetworkPanel.tsx";

const TABS = [
  { label: "Overview", value: "overview" },
  { label: "Peers", value: "peers" },
  { label: "Network", value: "network" },
] as const;

export const Dashboard = () => {
  const { Box, Tabs, ScrollArea } = usePrimitives();
  const [tab, setTab] = createSignal("overview");

  return (
    <Box direction="column" grow={1}>
      <Tabs tabs={TABS} selected={tab()} onSelect={setTab}>
        <ScrollArea>
          <Switch>
            <Match when={tab() === "overview"}>
              <SyncOverview />
            </Match>
            <Match when={tab() === "peers"}>
              <PeerTable />
            </Match>
            <Match when={tab() === "network"}>
              <NetworkPanel />
            </Match>
          </Switch>
        </ScrollArea>
      </Tabs>
    </Box>
  );
};
