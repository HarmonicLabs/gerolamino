/**
 * Text — semantic + sized text span. Sizes / colors / weights map to
 * Tailwind utility classes for static class strings (literal keys, no
 * interpolation), so the JIT picks them up at build time.
 */
import type { Component } from "solid-js";
import { cn } from "../../lib/cn";
import type { TextProps } from "../../primitives";

const sizeClass = {
  xs: "text-xs",
  sm: "text-sm",
  md: "text-base",
  lg: "text-lg",
  xl: "text-xl",
} as const;

const colorClass = {
  default: "",
  muted: "text-muted-foreground",
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  error: "text-error-foreground",
  accent: "text-accent-foreground",
} as const;

export const Text: Component<TextProps> = (props) => (
  <span
    class={cn(
      sizeClass[props.size ?? "md"],
      colorClass[props.color ?? "default"],
      props.weight === "bold" && "font-bold",
      props.class,
    )}
  >
    {props.children}
  </span>
);
