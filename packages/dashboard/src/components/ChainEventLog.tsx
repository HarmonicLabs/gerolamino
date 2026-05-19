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
import { For, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useAtomValue } from "@effect/atom-solid";
import Check from "lucide-solid/icons/check";
import Undo2 from "lucide-solid/icons/undo-2";
import Calendar from "lucide-solid/icons/calendar";
import ArrowRight from "lucide-solid/icons/arrow-right";
import type { LucideIcon } from "lucide-solid";
import { chainEventLogAtom, ChainEventEntry } from "../atoms/node-state.ts";
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

const titleFor = (e: ChainEventEntry): string =>
  ChainEventEntry.match(e, {
    BlockAccepted: ({ slot, blockNo }) => `Block accepted at slot ${slot} (#${blockNo})`,
    RolledBack: ({ depth }) => `Rolled back ${depth} block${depth === 1 ? "" : "s"}`,
    TipAdvanced: ({ slot }) => `Tip advanced to slot ${slot}`,
    EpochBoundary: ({ fromEpoch, toEpoch }) => `Epoch ${fromEpoch} → ${toEpoch}`,
  });

export interface ChainEventLogProps {
  /** Pixel max-height of the inner scroll area. Defaults to 400. */
  readonly height?: number;
}

export const ChainEventLog: Component<ChainEventLogProps> = (props) => {
  const { Section, Text, ScrollArea, LogRow } = usePrimitives();
  const events = useAtomValue(() => chainEventLogAtom);
  // Newest-first via CSS `flex-direction: column-reverse` — saves a
  // 1000-element `toReversed()` allocation on every popup tick. The
  // children iterate in insertion order; column-reverse paints them
  // bottom-to-top so the visual order is newest-on-top.

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
          <div class="flex flex-col-reverse">
            <For each={events()}>
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
          </div>
        </Show>
      </ScrollArea>
    </Section>
  );
};
