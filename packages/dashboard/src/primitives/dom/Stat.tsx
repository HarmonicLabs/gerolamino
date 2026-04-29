/**
 * Stat — labelled numeric/text statistic with optional trend arrow.
 * `▲ ▼` glyphs match the prior browser-primitives shape; preserved for
 * visual continuity in the chrome-ext popup migration.
 */
import { Show, type Component } from "solid-js";
import { cn } from "../../lib/cn";
import type { StatProps } from "../../primitives";

// `neutral` glyph is the empty string, so rendering unconditionally with
// `props.trend ?? "neutral"` produces nothing visible when no trend is set
// — same UX as the prior `<Show>` guard, but without the non-null assertion.
const trendGlyph = { up: "▲ ", down: "▼ ", neutral: "" } as const;

export const Stat: Component<StatProps> = (props) => (
  <div class={cn("min-w-20", props.class)}>
    <div class="text-xs uppercase text-muted-foreground">{props.label}</div>
    <div class="text-base font-bold text-foreground">
      {trendGlyph[props.trend ?? "neutral"]}
      {String(props.value)}
    </div>
    <Show when={props.description}>
      <div class="text-xs text-muted-foreground">{props.description}</div>
    </Show>
  </div>
);
