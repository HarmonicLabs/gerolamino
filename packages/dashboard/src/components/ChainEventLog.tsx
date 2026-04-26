/**
 * ChainEventLog — streaming feed of consensus events from the bounded-ring
 * `chainEventLogAtom` (capped at 1000 entries).
 *
 * Each event maps to a tag-colored `LogRow` with a lucide icon:
 *   - BlockAccepted → Check / success
 *   - RolledBack    → Undo2 / warning
 *   - TipAdvanced   → ArrowRight / neutral
 *   - EpochBoundary → Calendar / info
 *
 * Renders newest-first by reversing the atom's natural order (tail =
 * latest). Auto-scroll-pin (don't yank the viewport when the user has
 * scrolled up to read older events) is left for a follow-up — the
 * primitive ScrollArea is plain native overflow, so the basic UX is
 * "newest-on-top, manual scroll".
 */
import { For, Show, type Component } from "solid-js";
import { useAtomValue } from "@effect/atom-solid";
import Check from "lucide-solid/icons/check";
import Undo2 from "lucide-solid/icons/undo-2";
import Calendar from "lucide-solid/icons/calendar";
import ArrowRight from "lucide-solid/icons/arrow-right";
import { chainEventLogAtom, type ChainEventEntry } from "../atoms/node-state.ts";
import { usePrimitives } from "../primitives.ts";
import type { LogRowProps } from "../primitives.ts";

const tagFor = (e: ChainEventEntry): LogRowProps["tag"] => {
  switch (e._tag) {
    case "BlockAccepted":
      return "success";
    case "RolledBack":
      return "warning";
    case "TipAdvanced":
      return "neutral";
    case "EpochBoundary":
      return "info";
  }
};

const IconFor: Component<{ event: ChainEventEntry }> = (props) => {
  switch (props.event._tag) {
    case "BlockAccepted":
      return <Check />;
    case "RolledBack":
      return <Undo2 />;
    case "TipAdvanced":
      return <ArrowRight />;
    case "EpochBoundary":
      return <Calendar />;
  }
};

const titleFor = (e: ChainEventEntry): string => {
  switch (e._tag) {
    case "BlockAccepted":
      return `Block accepted at slot ${e.slot} (#${e.blockNo})`;
    case "RolledBack":
      return `Rolled back ${e.depth} block${e.depth === 1 ? "" : "s"}`;
    case "TipAdvanced":
      return `Tip advanced to slot ${e.slot}`;
    case "EpochBoundary":
      return `Epoch ${e.fromEpoch} → ${e.toEpoch}`;
  }
};

export const ChainEventLog = () => {
  const { Box, Text, ScrollArea, LogRow } = usePrimitives();
  const events = useAtomValue(() => chainEventLogAtom);

  return (
    <Box direction="column" gap={1}>
      <Text size="md" weight="bold">
        {`Chain events (${events().length})`}
      </Text>
      <ScrollArea maxHeight={400}>
        <Show
          when={events().length > 0}
          fallback={
            <Text size="sm" color="muted">
              No events yet — waiting for chain data…
            </Text>
          }
        >
          <For each={events().toReversed()}>
            {(e) => (
              <LogRow
                tag={tagFor(e)}
                icon={<IconFor event={e} />}
                title={<span>{titleFor(e)}</span>}
              />
            )}
          </For>
        </Show>
      </ScrollArea>
    </Box>
  );
};
