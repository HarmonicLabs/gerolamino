/**
 * DashboardPrimitives — platform abstraction for dashboard UI.
 *
 * Dashboard components consume UI primitives via SolidJS context. Each
 * platform (Bun.WebView in apps/tui, WXT popup in packages/chrome-ext)
 * provides its own implementation. The canonical DOM adapter lives in
 * `./primitives/dom/` (Tailwind v4 + Kobalte + Corvu) and is consumed by
 * both hosts. The legacy OpenTUI primitives have been removed.
 *
 * This keeps `packages/dashboard` host-agnostic — components never touch a
 * render API directly; they call into the primitives context.
 */
import { createContext, useContext } from "solid-js";
import type { Component, JSX, ParentComponent } from "solid-js";
import { invariant } from "es-toolkit/util";

// ---------------------------------------------------------------------------
// Primitive prop interfaces
// ---------------------------------------------------------------------------

export interface BoxProps {
  readonly direction?: "row" | "column";
  readonly gap?: number;
  readonly padding?: number;
  readonly border?: boolean;
  readonly grow?: number;
  readonly class?: string;
  readonly children?: JSX.Element;
}

export interface TextProps {
  readonly size?: "xs" | "sm" | "md" | "lg" | "xl";
  readonly weight?: "normal" | "bold";
  readonly color?: "default" | "muted" | "success" | "warning" | "error" | "accent";
  readonly class?: string;
  readonly children?: JSX.Element;
}

export interface BadgeProps {
  readonly variant: "default" | "success" | "warning" | "error" | "outline";
  readonly class?: string;
  readonly children?: JSX.Element;
}

export interface ProgressProps {
  readonly value: number;
  readonly max?: number;
  readonly class?: string;
}

export interface CardProps {
  readonly title?: string;
  readonly description?: string;
  readonly class?: string;
  readonly children?: JSX.Element;
}

export interface StatProps {
  readonly label: string;
  readonly value: string | number;
  readonly description?: string;
  readonly trend?: "up" | "down" | "neutral";
  readonly class?: string;
}

export interface TabsProps {
  readonly tabs: readonly { readonly label: string; readonly value: string }[];
  readonly selected: string;
  readonly onSelect: (value: string) => void;
  readonly class?: string;
  readonly children?: JSX.Element;
}

export interface TableColumn<T> {
  readonly header: string;
  readonly accessor: (row: T) => string | number;
  readonly align?: "left" | "center" | "right";
}

export interface TableProps<T> {
  readonly columns: readonly TableColumn<T>[];
  readonly data: readonly T[];
  readonly class?: string;
}

export interface ScrollAreaProps {
  readonly maxHeight?: string | number;
  readonly class?: string;
  readonly children?: JSX.Element;
}

export interface SeparatorProps {
  readonly orientation?: "horizontal" | "vertical";
  readonly class?: string;
}

// ---------------------------------------------------------------------------
// New primitive prop interfaces (this wave)
// ---------------------------------------------------------------------------

/**
 * 3-panel resizable layout shell. Panels collapse to a Tabs fallback at
 * narrow widths (the DOM adapter wires this up via
 * `@solid-primitives/resize-observer`).
 */
export interface LayoutProps {
  readonly left: JSX.Element;
  readonly center: JSX.Element;
  readonly right: JSX.Element;
  readonly leftLabel: string;
  readonly centerLabel: string;
  readonly rightLabel: string;
  /** Pixel viewport width below which the layout falls back to Tabs. Default 768. */
  readonly tabsBelow?: number;
  readonly class?: string;
}

/** Hover-card tooltip with delay-on-show. */
export interface TooltipProps {
  readonly content: JSX.Element;
  readonly children: JSX.Element;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly class?: string;
}

/** Icon-only square button. Composed from Button with `size: "icon"`. */
export interface IconButtonProps {
  readonly variant?: "default" | "ghost" | "outline";
  readonly ariaLabel: string;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly class?: string;
  readonly children: JSX.Element;
}

/**
 * Streaming sparkline backed by uPlot. The component's adapter owns the
 * imperative uPlot lifecycle (mount + setData on `data` change + destroy
 * on cleanup); consumers pass a reactive 1-D number array.
 */
export interface SparklineProps {
  /** Reactive Y values; the X axis is rebuilt from index + sample period. */
  readonly data: readonly number[];
  /** Sample period (ms) — used to derive X-axis timestamps. Default 1000. */
  readonly samplePeriodMs?: number;
  /** Pixel height of the rendered chart. Default 64. */
  readonly height?: number;
  /** Optional accent color CSS variable name. Default `--primary`. */
  readonly colorVar?: string;
  readonly class?: string;
}

/**
 * One row in a tagged log feed (used by `ChainEventLog`). Consumers supply
 * a leading icon, the row body, and an optional secondary timestamp. The
 * adapter owns badge color theming via the `tag` discriminator.
 */
export interface LogRowProps {
  readonly tag: "success" | "warning" | "info" | "neutral" | "error";
  readonly icon: JSX.Element;
  readonly title: JSX.Element;
  readonly subtitle?: JSX.Element;
  readonly timestamp?: JSX.Element;
  readonly class?: string;
}

// ---------------------------------------------------------------------------
// Primitives context
// ---------------------------------------------------------------------------

export interface DashboardPrimitives {
  readonly Box: ParentComponent<BoxProps>;
  readonly Text: Component<TextProps>;
  readonly Badge: Component<BadgeProps>;
  readonly Progress: Component<ProgressProps>;
  readonly Card: ParentComponent<CardProps>;
  readonly Stat: Component<StatProps>;
  readonly Tabs: ParentComponent<TabsProps>;
  readonly Table: <T>(props: TableProps<T>) => JSX.Element;
  readonly ScrollArea: ParentComponent<ScrollAreaProps>;
  readonly Separator: Component<SeparatorProps>;

  // New (this wave) — additive on the DashboardPrimitives interface so
  // existing OpenTUI / browser-primitives implementations that haven't
  // been migrated yet would surface a missing-key TypeScript error
  // (intentional — the legacy chrome-ext browser-primitives.tsx was
  // deleted in this same wave; no other consumers).
  readonly Layout: Component<LayoutProps>;
  readonly Tooltip: Component<TooltipProps>;
  readonly IconButton: Component<IconButtonProps>;
  readonly Sparkline: Component<SparklineProps>;
  readonly LogRow: Component<LogRowProps>;
}

const PrimitivesContext = createContext<DashboardPrimitives>();

export const PrimitivesProvider = PrimitivesContext.Provider;

export const usePrimitives = (): DashboardPrimitives => {
  const ctx = useContext(PrimitivesContext);
  // `invariant` narrows via `asserts condition` so the return doesn't need
  // a non-null assertion. Throws at render time when a component is used
  // outside a `PrimitivesProvider` wrapper — an unambiguous programmer
  // error, not a recoverable runtime condition.
  invariant(ctx, "DashboardPrimitives not provided — wrap with PrimitivesProvider");
  return ctx;
};
