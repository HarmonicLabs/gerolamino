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
 * latest). With a newest-on-top layout, prepended rows naturally remain
 * visible when the user is at scrollTop=0 (live tail), and shifted
 * scroll-position (when reading older events) is preferred over a
 * forced auto-scroll, so no scroll-pin logic is needed here.
 */
import { For, Show, createMemo, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useAtomValue } from "@effect/atom-solid";
import Check from "lucide-solid/icons/check";
import Undo2 from "lucide-solid/icons/undo-2";
import Calendar from "lucide-solid/icons/calendar";
import ArrowRight from "lucide-solid/icons/arrow-right";
import type { LucideIcon } from "lucide-solid";
import { chainEventLogAtom, type ChainEventEntry } from "../atoms/node-state.ts";
import { usePrimitives } from "../primitives.ts";
import type { LogRowProps } from "../primitives.ts";

// Icon glyph size matches the LogRow tag-badge container (`size-6` = 24px)
// minus an internal 2px ring of padding — keeps the visual weight uniform
// across the four event tags. lucide-solid defaults to 24/strokeWidth 2.
const ICON_SIZE = 16;
const ICON_STROKE = 2.25;

// Discriminator-keyed lookup tables. Typed as `LucideIcon` (not bare
// `Component`) so `<Dynamic>` knows the forwarded props (`size`,
// `strokeWidth`) match the icon contract — surfaces typos at compile
// time instead of as runtime "undefined attribute" warnings.
const TAG_FOR: Record<ChainEventEntry["_tag"], LogRowProps["tag"]> = {
  BlockAccepted: "success",
  RolledBack: "warning",
  TipAdvanced: "neutral",
  EpochBoundary: "info",
};

const ICON_FOR: Record<ChainEventEntry["_tag"], LucideIcon> = {
  BlockAccepted: Check,
  RolledBack: Undo2,
  TipAdvanced: ArrowRight,
  EpochBoundary: Calendar,
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

export interface ChainEventLogProps {
  /** Pixel max-height of the inner scroll area. Defaults to 400. */
  readonly height?: number;
}

export const ChainEventLog: Component<ChainEventLogProps> = (props) => {
  const { Section, Text, ScrollArea, LogRow } = usePrimitives();
  const events = useAtomValue(() => chainEventLogAtom);
  // `toReversed()` allocates a new array; wrapping in `createMemo` keeps
  // it bound to atom updates only, instead of re-allocating on every
  // unrelated reactive read in the surrounding tracking scope.
  const reversedEvents = createMemo(() => events().toReversed());

  return (
    <Section title={`Chain events (${events().length})`}>
      <ScrollArea maxHeight={props.height ?? 400}>
        <Show
          when={events().length > 0}
          fallback={
            <Text size="sm" color="muted">
              No events yet — waiting for chain data…
            </Text>
          }
        >
          <For each={reversedEvents()}>
            {(e) => (
              <LogRow
                tag={TAG_FOR[e._tag]}
                icon={
                  <Dynamic
                    component={ICON_FOR[e._tag]}
                    size={ICON_SIZE}
                    strokeWidth={ICON_STROKE}
                  />
                }
                title={<span>{titleFor(e)}</span>}
              />
            )}
          </For>
        </Show>
      </ScrollArea>
    </Section>
  );
};
