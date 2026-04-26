/**
 * Stat — labelled numeric/text statistic with optional trend arrow.
 * `▲ ▼` glyphs match the prior browser-primitives shape; preserved for
 * visual continuity in the chrome-ext popup migration.
 */
import { Show, type Component } from "solid-js";
import { cn } from "../../lib/cn";
import type { StatProps } from "../../primitives";

const trendGlyph = { up: "▲ ", down: "▼ ", neutral: "" } as const;

export const Stat: Component<StatProps> = (props) => (
  <div class={cn("min-w-[80px]", props.class)}>
    <div class="text-xs uppercase text-muted-foreground">{props.label}</div>
    <div class="text-base font-bold text-foreground">
      <Show when={props.trend}>{trendGlyph[props.trend!]}</Show>
      {String(props.value)}
    </div>
    <Show when={props.description}>
      <div class="text-xs text-muted-foreground">{props.description}</div>
    </Show>
  </div>
);
