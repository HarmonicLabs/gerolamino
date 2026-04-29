/**
 * Layout — 3-panel resizable shell with a Tabs fallback at narrow widths.
 *
 * Wide path: `@corvu/resizable` builds horizontal `Panel | Handle | Panel
 * | Handle | Panel`. Sizes are persisted via `@solid-primitives/storage`'s
 * `makePersisted` so the user's layout survives popup close/reopen and
 * full TUI restart.
 *
 * Narrow path: when the container's measured width drops below
 * `tabsBelow` (default 768px), we fall back to a single-panel-at-a-time
 * `aria-pressed` button group. `@solid-primitives/resize-observer`
 * `createElementSize` gives us the live container width as a reactive
 * signal that auto-disconnects its inner `ResizeObserver` on scope
 * cleanup.
 *
 * The narrow-mode toggle uses `aria-pressed` buttons rather than
 * `role="tablist"` / `role="tab"` triggers because the wide-path layout's
 * center panel often hosts a Kobalte `<Tabs>` — an outer tablist would
 * create a nested-tablist ARIA violation when narrow mode renders the
 * Kobalte tablist inside the active panel. Buttons + aria-pressed convey
 * toggle-state semantics without claiming tablist semantics.
 */
import { createSignal, For, Match, Show, Switch, type Component } from "solid-js";
import { makePersisted } from "@solid-primitives/storage";
import ResizablePrimitive from "@corvu/resizable";
import { createElementSize } from "@solid-primitives/resize-observer";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/cn";
import type { LayoutProps } from "../../primitives";

const DEFAULT_STORAGE_KEY = "dashboard.layout.sizes";
const DEFAULT_SIZES: ReadonlyArray<number> = [0.3, 0.4, 0.3];

// Custom (de)serializer pair: validates shape on read so a corrupted /
// schema-drifted localStorage entry falls back to defaults instead of
// crashing the resizable on a malformed `sizes` prop.
const serialize = (data: number[]): string => JSON.stringify(data);
const deserialize = (raw: string): number[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === DEFAULT_SIZES.length &&
      parsed.every((n): n is number => typeof n === "number" && Number.isFinite(n))
    ) {
      return parsed;
    }
  } catch {
    // ignore JSON.parse failures; same fallback as a missing key
  }
  return [...DEFAULT_SIZES];
};

// `w-2` (8px) gives the resize handle a comfortable mouse + touch
// hit-target; the `after:w-px` pseudo-element draws the visual hairline
// at center so the wider hit zone is invisible. `cursor-col-resize`
// matches the OS pointer affordance Corvu's pointer-capture expects.
const handleClass =
  "relative flex w-2 shrink-0 cursor-col-resize items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border hover:after:bg-accent focus-visible:outline-none";

const tabButtonVariants = cva(
  "inline-flex items-center justify-center rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
  {
    variants: {
      active: {
        true: "bg-background text-foreground shadow-sm",
        false: "",
      },
    },
    defaultVariants: { active: false },
  },
);

type Tab = { readonly id: "left" | "center" | "right"; readonly label: string };

export const Layout: Component<LayoutProps> = (props) => {
  // `createElementSize` owns its own `ResizeObserver` and disconnects on
  // scope cleanup — no manual `onCleanup` plumbing.
  let containerRef!: HTMLDivElement;
  const size = createElementSize(() => containerRef);
  const [activeTab, setActiveTab] = createSignal<"left" | "center" | "right">("center");

  // Controlled Resizable sizes, persisted to localStorage via `makePersisted`.
  // It handles the "read on mount → write on change" lifecycle internally
  // (no redundant initial-mount write) and skips persistence cleanly when
  // localStorage is unavailable (SSR / privacy mode).
  const [sizes, setSizes] = makePersisted(
    createSignal<number[]>([...DEFAULT_SIZES]),
    {
      name: props.persistKey ?? DEFAULT_STORAGE_KEY,
      serialize,
      deserialize,
    },
  );

  const tabsBelow = (): number => props.tabsBelow ?? 768;
  const width = (): number => size.width ?? 0;
  const showTabs = (): boolean => width() > 0 && width() < tabsBelow();

  // Reactive accessors so the narrow-mode tab labels reflect prop updates
  // without relying on `props.{leftLabel, ...}` being read inside <For>.
  const tabs = (): readonly Tab[] => [
    { id: "left", label: props.leftLabel },
    { id: "center", label: props.centerLabel },
    { id: "right", label: props.rightLabel },
  ];

  return (
    <div ref={containerRef} class={cn("flex size-full flex-col", props.class)}>
      <Show
        when={showTabs()}
        fallback={
          <ResizablePrimitive
            sizes={sizes()}
            onSizesChange={setSizes}
            class="flex size-full flex-row"
          >
            <ResizablePrimitive.Panel minSize={0.15}>{props.left}</ResizablePrimitive.Panel>
            <ResizablePrimitive.Handle class={handleClass} />
            <ResizablePrimitive.Panel minSize={0.2}>{props.center}</ResizablePrimitive.Panel>
            <ResizablePrimitive.Handle class={handleClass} />
            <ResizablePrimitive.Panel minSize={0.15}>{props.right}</ResizablePrimitive.Panel>
          </ResizablePrimitive>
        }
      >
        <div class="flex w-full flex-col">
          <div
            role="group"
            aria-label="Layout view"
            class="inline-flex h-10 items-center justify-start self-start rounded-md bg-muted p-1 text-muted-foreground"
          >
            <For each={tabs()}>
              {(tab) => (
                <button
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  aria-pressed={activeTab() === tab.id}
                  class={tabButtonVariants({ active: activeTab() === tab.id })}
                >
                  {tab.label}
                </button>
              )}
            </For>
          </div>
          <div class="mt-2 flex-1">
            <Switch>
              <Match when={activeTab() === "left"}>{props.left}</Match>
              <Match when={activeTab() === "center"}>{props.center}</Match>
              <Match when={activeTab() === "right"}>{props.right}</Match>
            </Switch>
          </div>
        </div>
      </Show>
    </div>
  );
};
