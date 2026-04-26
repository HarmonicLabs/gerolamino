/**
 * Card — bordered surface with optional title + description header.
 * Adapted from solid-ui's `card.tsx` (which exposes Header / Title /
 * Description / Content as separate components); our primitive flattens
 * those into a single `{title?, description?, children}` shape because
 * the dashboard's only consumer pattern is a header-then-body card.
 */
import { Show, type ParentComponent } from "solid-js";
import { cn } from "../../lib/cn";
import type { CardProps } from "../../primitives";

export const Card: ParentComponent<CardProps> = (props) => (
  <div class={cn("rounded-lg border bg-card text-card-foreground shadow-sm", props.class)}>
    <Show when={props.title || props.description}>
      <div class="flex flex-col space-y-1.5 p-4">
        <Show when={props.title}>
          <h3 class="font-semibold leading-none tracking-tight">{props.title}</h3>
        </Show>
        <Show when={props.description}>
          <p class="text-sm text-muted-foreground">{props.description}</p>
        </Show>
      </div>
    </Show>
    <div class="p-4 pt-0">{props.children}</div>
  </div>
);
