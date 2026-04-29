/**
 * Tooltip — Kobalte-backed hover card with configurable open/close delays.
 *
 * `placement` is a Kobalte placement string (`"top" | "right" | "bottom" | "left"`
 * plus side variants like `"top-start"`); we expose only the four cardinal
 * directions on `TooltipProps["side"]` because that's all the dashboard
 * needs. `gutter={4}` keeps the tooltip ~4px off the trigger.
 *
 * `openDelay` / `closeDelay` thread to Kobalte's `TooltipRoot` (defaults
 * 700ms / 300ms per `@kobalte/core/tooltip/tooltip-root.tsx:80-84`).
 */
import * as TooltipPrimitive from "@kobalte/core/tooltip";
import type { Component } from "solid-js";
import { cn } from "../../lib/cn";
import type { TooltipProps } from "../../primitives";

export const Tooltip: Component<TooltipProps> = (props) => (
  <TooltipPrimitive.Root
    gutter={4}
    placement={props.side ?? "top"}
    openDelay={props.openDelay}
    closeDelay={props.closeDelay}
  >
    <TooltipPrimitive.Trigger as="span">{props.children}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        class={cn(
          "z-50 origin-[var(--kb-popover-content-transform-origin)] overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md",
          props.class,
        )}
      >
        {props.content}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>
);
