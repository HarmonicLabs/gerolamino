/**
 * Tabs — Kobalte-backed tab nav. The dashboard's panel switching is
 * external (callers render their own Switch/Match block as `children`),
 * so we render `TabsPrimitive.Root` + `.List` + `.Trigger`s but skip
 * `.Content` — children sit below the trigger row in plain markup.
 * Kobalte still owns ARIA + keyboard handling for the trigger row.
 */
import { For, type ParentComponent } from "solid-js";
import * as TabsPrimitive from "@kobalte/core/tabs";
import { cn } from "../../lib/cn";
import type { TabsProps } from "../../primitives";

export const Tabs: ParentComponent<TabsProps> = (props) => (
  <TabsPrimitive.Root
    value={props.selected}
    onChange={props.onSelect}
    class={cn("flex w-full flex-col", props.class)}
  >
    <TabsPrimitive.List class="inline-flex h-10 items-center justify-start self-start rounded-md bg-muted p-1 text-muted-foreground">
      <For each={[...props.tabs]}>
        {(tab) => (
          <TabsPrimitive.Trigger
            value={tab.value}
            class="inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all data-[selected]:bg-background data-[selected]:text-foreground data-[selected]:shadow-sm"
          >
            {tab.label}
          </TabsPrimitive.Trigger>
        )}
      </For>
    </TabsPrimitive.List>
    <div class="mt-2">{props.children}</div>
  </TabsPrimitive.Root>
);
