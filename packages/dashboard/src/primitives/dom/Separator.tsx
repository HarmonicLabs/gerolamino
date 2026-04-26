/**
 * Separator — horizontal/vertical 1px divider. ARIA `role="separator"`
 * + `aria-orientation` so screen readers can announce it correctly.
 */
import type { Component } from "solid-js";
import { cn } from "../../lib/cn";
import type { SeparatorProps } from "../../primitives";

export const Separator: Component<SeparatorProps> = (props) => (
  <div
    role="separator"
    aria-orientation={props.orientation ?? "horizontal"}
    class={cn(
      "shrink-0 bg-border",
      props.orientation === "vertical" ? "h-full w-px" : "h-px w-full",
      props.class,
    )}
  />
);
