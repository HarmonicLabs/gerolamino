/**
 * SyncOverview — main dashboard view showing node sync status.
 * Platform-agnostic: renders via DashboardPrimitives context.
 */
import { Show } from "solid-js";
import { useAtomValue } from "@effect/atom-solid";
import {
  nodeStateAtom,
  syncPercentLabelAtom,
  slotsBehindAtom,
  bootstrapAtom,
} from "../atoms/node-state.ts";
import { usePrimitives } from "../primitives.ts";

const statusVariant = (status: string) => {
  switch (status) {
    case "caught-up":
      return "success" as const;
    case "syncing":
    case "bootstrapping":
    case "connecting":
      return "warning" as const;
    case "error":
      return "error" as const;
    default:
      return "default" as const;
  }
};

const statusLabel = (status: string) => {
  switch (status) {
    case "caught-up":
      return "Caught Up";
    case "syncing":
      return "Syncing";
    case "bootstrapping":
      return "Bootstrapping";
    case "connecting":
      return "Connecting";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
};

const phaseLabel = (phase: string, status: string) => {
  switch (phase) {
    case "ledger-state":
      return "Receiving ledger state";
    case "utxo-entries":
      return "Syncing UTxO set";
    case "blocks":
      return "Syncing blocks";
    case "complete":
      return "Complete";
    default:
      return status === "connecting" ? "Connecting..." : "Starting...";
  }
};

export const SyncOverview = () => {
  const { Box, Text, Badge, Progress, Card, Stat, Separator } = usePrimitives();
  const state = useAtomValue(nodeStateAtom);
  const syncLabel = useAtomValue(syncPercentLabelAtom);
  const slotsBehind = useAtomValue(slotsBehindAtom);
  const bootstrap = useAtomValue(bootstrapAtom);

  return (
    <Box direction="column" gap={1}>
      {/* Header */}
      <Box direction="row" gap={1}>
        <Text size="lg" weight="bold">
          Gerolamino
        </Text>
        <Badge variant={statusVariant(state().status)}>{statusLabel(state().status)}</Badge>
      </Box>

      <Separator />

      {/* Stats grid */}
      <Box direction="row" gap={1}>
        <Stat
          label="Tip Slot"
          value={state().tipSlot.toString()}
          description={`Epoch ${state().epochNumber.toString()}`}
        />
        <Stat
          label="Sync"
          value={syncLabel()}
          trend={state().syncPercent >= 99 ? "up" : "neutral"}
        />
        <Stat label="Blocks" value={state().blocksProcessed.toLocaleString()} />
        <Stat label="Behind" value={slotsBehind().toString()} description="slots" />
      </Box>

      {/* Sync progress bar (relay sync phase) */}
      <Show when={state().status === "syncing"}>
        <Progress value={state().syncPercent} />
      </Show>

      {/* Bootstrap progress — show during connecting, bootstrapping, or when phase is active */}
      <Show
        when={
          state().status === "connecting" ||
          state().status === "bootstrapping" ||
          (bootstrap().phase !== "idle" && bootstrap().phase !== "complete")
        }
      >
        <Card title={`Bootstrap — ${phaseLabel(bootstrap().phase, state().status)}`}>
          <Box direction="column" gap={1}>
            <Show when={bootstrap().snapshotSlot !== "0"}>
              <Text size="sm" color="muted">
                Snapshot slot: {bootstrap().snapshotSlot}
              </Text>
            </Show>

            {/* Ledger state */}
            <Box direction="row" gap={1}>
              <Badge variant={bootstrap().ledgerStateReceived ? "success" : "outline"}>
                {bootstrap().ledgerStateReceived
                  ? "Ledger state received"
                  : "Awaiting ledger state"}
              </Badge>
            </Box>

            {/* UTxO entries progress */}
            <Show when={bootstrap().blobEntriesReceived > 0 || bootstrap().totalBlobEntries > 0}>
              <Box direction="column" gap={0}>
                <Box direction="row" gap={1}>
                  <Text size="sm" weight="bold">
                    UTxO entries
                  </Text>
                  <Text size="sm" color="muted">
                    {bootstrap().blobEntriesReceived.toLocaleString()}
                    {bootstrap().totalBlobEntries > 0
                      ? ` / ${bootstrap().totalBlobEntries.toLocaleString()}`
                      : ""}
                  </Text>
                </Box>
                <Show when={bootstrap().totalBlobEntries > 0}>
                  <Progress
                    value={bootstrap().blobEntriesReceived}
                    max={bootstrap().totalBlobEntries}
                  />
                </Show>
              </Box>
            </Show>

            {/* Blocks progress */}
            <Show when={bootstrap().blocksReceived > 0}>
              <Box direction="column" gap={0}>
                <Box direction="row" gap={1}>
                  <Text size="sm" weight="bold">
                    Blocks
                  </Text>
                  <Text size="sm" color="muted">
                    {bootstrap().blocksReceived.toLocaleString()}
                  </Text>
                </Box>
              </Box>
            </Show>
          </Box>
        </Card>
      </Show>

      {/* Bootstrap complete badge */}
      <Show when={bootstrap().phase === "complete"}>
        <Badge variant="success">Bootstrap complete</Badge>
      </Show>

      {/* Error display */}
      <Show when={state().lastError}>
        <Card title="Error">
          <Text size="sm" color="error">
            {state().lastError}
          </Text>
        </Card>
      </Show>
    </Box>
  );
};
