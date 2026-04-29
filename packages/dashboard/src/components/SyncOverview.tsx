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
  syncSparklineAtom,
  type SyncStatus,
  type BootstrapPhase,
} from "../atoms/node-state.ts";
import { usePrimitives } from "../primitives.ts";
import type { BadgeProps } from "../primitives.ts";

// Single source of truth for status-derived UI: variant + label live
// together in one record so they can't drift apart on schema evolution
// (adding a new SyncStatus variant fails to compile here, not silently
// at render time). `BadgeProps["variant"]` propagates through.
const STATUS_CONFIG: Record<SyncStatus, { variant: BadgeProps["variant"]; label: string }> = {
  idle: { variant: "default", label: "Idle" },
  connecting: { variant: "warning", label: "Connecting" },
  bootstrapping: { variant: "warning", label: "Bootstrapping" },
  syncing: { variant: "warning", label: "Syncing" },
  "caught-up": { variant: "success", label: "Caught Up" },
  error: { variant: "error", label: "Error" },
};

// `idle` is the only phase with a status-conditional label; every other
// phase has a single canonical string. Lookup-then-fallback is one branch
// vs the prior `Exclude` partition.
const PHASE_LABEL: Partial<Record<BootstrapPhase, string>> = {
  "awaiting-init": "Awaiting snapshot metadata",
  "awaiting-ledger-state": "Receiving ledger state",
  "decoding-ledger-state": "Decoding ledger state (off-thread)",
  "writing-accounts": "Writing accounts",
  "receiving-utxos": "Syncing UTxO set",
  "receiving-blocks": "Syncing blocks",
  "writing-stake": "Writing stake distribution",
  complete: "Complete",
};

const phaseLabel = (phase: BootstrapPhase, status: SyncStatus): string =>
  PHASE_LABEL[phase] ?? (status === "connecting" ? "Connecting..." : "Starting...");

export const SyncOverview = () => {
  const { Box, Text, Badge, Progress, Card, Stat, Separator, Sparkline } = usePrimitives();
  const state = useAtomValue(() => nodeStateAtom);
  const syncLabel = useAtomValue(() => syncPercentLabelAtom);
  const slotsBehind = useAtomValue(() => slotsBehindAtom);
  const bootstrap = useAtomValue(() => bootstrapAtom);
  const sparkline = useAtomValue(() => syncSparklineAtom);

  return (
    <Box direction="column" gap={1}>
      {/* Header */}
      <Box direction="row" gap={1}>
        <Text size="lg" weight="bold">
          Gerolamino
        </Text>
        <Badge variant={STATUS_CONFIG[state().status].variant}>
          {STATUS_CONFIG[state().status].label}
        </Badge>
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

      {/* Slot-velocity sparkline — derived 1Hz over a 600-sample sliding
          window; only render once we have at least two points so uPlot
          has a real range to draw. */}
      <Show when={sparkline().length >= 2}>
        <Card title="Slots behind (last 10 min)">
          <Sparkline data={sparkline()} samplePeriodMs={1000} height={56} />
        </Card>
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
              <Badge variant={bootstrap().ledgerStateDecoded ? "success" : "outline"}>
                {bootstrap().ledgerStateDecoded ? "Ledger state decoded" : "Decoding ledger state"}
              </Badge>
            </Box>

            {/* Accounts progress */}
            <Show when={bootstrap().accountsWritten > 0 || bootstrap().totalAccounts !== undefined}>
              <Box direction="column" gap={0}>
                <Box direction="row" gap={1}>
                  <Text size="sm" weight="bold">
                    Accounts
                  </Text>
                  <Text size="sm" color="muted">
                    {bootstrap().accountsWritten.toLocaleString()}
                    <Show when={bootstrap().totalAccounts} keyed>
                      {(total) => ` / ${total.toLocaleString()}`}
                    </Show>
                  </Text>
                </Box>
                {/* `<Show keyed>` narrows `totalAccounts` to a defined truthy
                    number — `0` and `undefined` are both falsy, replacing the
                    `defined && > 0` guard plus two non-null assertions. */}
                <Show when={bootstrap().totalAccounts} keyed>
                  {(total) => (
                    <Progress value={bootstrap().accountsWritten} max={total} />
                  )}
                </Show>
              </Box>
            </Show>

            {/* Stake entries progress */}
            <Show
              when={
                bootstrap().stakeEntriesWritten > 0 || bootstrap().totalStakeEntries !== undefined
              }
            >
              <Box direction="column" gap={0}>
                <Box direction="row" gap={1}>
                  <Text size="sm" weight="bold">
                    Stake entries
                  </Text>
                  <Text size="sm" color="muted">
                    {bootstrap().stakeEntriesWritten.toLocaleString()}
                    <Show when={bootstrap().totalStakeEntries} keyed>
                      {(total) => ` / ${total.toLocaleString()}`}
                    </Show>
                  </Text>
                </Box>
              </Box>
            </Show>

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
