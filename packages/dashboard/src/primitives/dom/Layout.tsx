/**
 * Layout — 3-panel resizable shell with a Tabs fallback at narrow widths.
 *
 * Wide path: `@corvu/resizable` builds horizontal `Panel | Handle | Panel
 * | Handle | Panel` with sensible default ratios (30 / 40 / 30) and a
 * minimum size per panel so the user can't accidentally collapse one
 * to zero width.
 *
 * Narrow path: when the container's measured width drops below
 * `tabsBelow` (default 768px), we fall back to a single-panel-at-a-time
 * tab UI. `@solid-primitives/resize-observer` gives us the live
 * container width as a signal, so the switch is reactive — resizing the
 * popup window flips between layouts without a remount.
 */
import { createSignal, createEffect, Show, type Component } from "solid-js";
import ResizablePrimitive from "@corvu/resizable";
import { makeResizeObserver } from "@solid-primitives/resize-observer";
import { cn } from "../../lib/cn";
import type { LayoutProps } from "../../primitives";

const handleClass =
  "relative flex w-px shrink-0 items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 hover:bg-accent focus-visible:outline-none";

const tabButtonClass = (active: boolean): string =>
  cn(
    "inline-flex items-center justify-center rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
    active && "bg-background text-foreground shadow-sm",
  );

export const Layout: Component<LayoutProps> = (props) => {
  let containerRef: HTMLDivElement | undefined;
  const [width, setWidth] = createSignal(0);
  const [activeTab, setActiveTab] = createSignal<"left" | "center" | "right">("center");

  const tabsBelow = (): number => props.tabsBelow ?? 768;
  const showTabs = (): boolean => width() > 0 && width() < tabsBelow();

  createEffect(() => {
    if (!containerRef) return;
    const { observe } = makeResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth(w);
    });
    observe(containerRef);
  });

  return (
    <div ref={containerRef} class={cn("flex size-full flex-col", props.class)}>
      <Show
        when={showTabs()}
        fallback={
          <ResizablePrimitive class="flex size-full flex-row">
            <ResizablePrimitive.Panel initialSize={0.3} minSize={0.15}>
              {props.left}
            </ResizablePrimitive.Panel>
            <ResizablePrimitive.Handle class={handleClass} />
            <ResizablePrimitive.Panel initialSize={0.4} minSize={0.2}>
              {props.center}
            </ResizablePrimitive.Panel>
            <ResizablePrimitive.Handle class={handleClass} />
            <ResizablePrimitive.Panel initialSize={0.3} minSize={0.15}>
              {props.right}
            </ResizablePrimitive.Panel>
          </ResizablePrimitive>
        }
      >
        <div class="flex w-full flex-col">
          <div
            role="tablist"
            class="inline-flex h-10 items-center justify-start self-start rounded-md bg-muted p-1 text-muted-foreground"
          >
            <button
              type="button"
              onClick={() => setActiveTab("left")}
              aria-selected={activeTab() === "left"}
              class={tabButtonClass(activeTab() === "left")}
            >
              {props.leftLabel}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("center")}
              aria-selected={activeTab() === "center"}
              class={tabButtonClass(activeTab() === "center")}
            >
              {props.centerLabel}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("right")}
              aria-selected={activeTab() === "right"}
              class={tabButtonClass(activeTab() === "right")}
            >
              {props.rightLabel}
            </button>
          </div>
          <div class="mt-2 flex-1">
            <Show when={activeTab() === "left"}>{props.left}</Show>
            <Show when={activeTab() === "center"}>{props.center}</Show>
            <Show when={activeTab() === "right"}>{props.right}</Show>
          </div>
        </div>
      </Show>
    </div>
  );
};
