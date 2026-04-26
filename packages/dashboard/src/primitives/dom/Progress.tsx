/**
 * Progress — Kobalte-backed determinate progress bar. The `--kb-progress-fill-width`
 * CSS var is set by Kobalte based on `value` / `maxValue`; the Fill consumes it
 * so we don't need to compute a percentage ourselves.
 */
import * as ProgressPrimitive from "@kobalte/core/progress";
import type { Component } from "solid-js";
import { cn } from "../../lib/cn";
import type { ProgressProps } from "../../primitives";

export const Progress: Component<ProgressProps> = (props) => (
  <ProgressPrimitive.Root
    value={props.value}
    maxValue={props.max ?? 100}
    class={cn("w-full", props.class)}
  >
    <ProgressPrimitive.Track class="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
      <ProgressPrimitive.Fill class="h-full w-[var(--kb-progress-fill-width)] flex-1 bg-primary transition-all" />
    </ProgressPrimitive.Track>
  </ProgressPrimitive.Root>
);
