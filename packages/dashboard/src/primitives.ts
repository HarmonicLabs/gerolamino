/**
 * DashboardPrimitives — platform abstraction for dashboard UI.
 *
 * Dashboard components consume UI primitives via SolidJS context.
 * Each platform (OpenTUI, browser) provides its own implementation:
 * - apps/tui: OpenTUI constructs (<box>, <text>, <scrollbox>, etc.)
 * - packages/chrome-ext: Kobalte/Solid UI (<div>, <span>, etc.)
 *
 * This keeps packages/dashboard platform-agnostic.
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
