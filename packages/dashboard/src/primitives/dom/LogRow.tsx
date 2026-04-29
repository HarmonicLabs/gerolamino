/**
 * LogRow — one row in a tagged log feed (used by `ChainEventLog`).
 *
 * Visual: a colored badge circle on the left holds the icon, with the
 * row title + optional subtitle in the middle and an optional timestamp
 * pinned to the right. The `tag` discriminator drives the badge color
 * via CVA `compoundVariants` — one tag → one (bg + fg) pair, which keeps
 * the bg/fg from drifting out of sync if the palette evolves.
 */
import { Show, type Component } from "solid-js";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/cn";
import type { LogRowProps } from "../../primitives";

const tagBadgeVariants = cva(
  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
  {
    variants: {
      tag: {
        success: "bg-success text-success-foreground",
        warning: "bg-warning text-warning-foreground",
        info: "bg-info text-info-foreground",
        neutral: "bg-muted text-muted-foreground",
        error: "bg-error text-error-foreground",
      },
    },
    defaultVariants: { tag: "neutral" },
  },
);

export const LogRow: Component<LogRowProps> = (props) => (
  <div
    class={cn("flex items-start gap-3 border-b border-border px-3 py-2 last:border-0", props.class)}
  >
    <span class={tagBadgeVariants({ tag: props.tag })}>{props.icon}</span>
    <div class="min-w-0 flex-1">
      <div class="text-sm">{props.title}</div>
      <Show when={props.subtitle}>
        <div class="text-xs text-muted-foreground">{props.subtitle}</div>
      </Show>
    </div>
    <Show when={props.timestamp}>
      <div class="ml-2 shrink-0 text-xs text-muted-foreground">{props.timestamp}</div>
    </Show>
  </div>
);
