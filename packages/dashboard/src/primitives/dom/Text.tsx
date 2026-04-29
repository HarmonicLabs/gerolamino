/**
 * Text — semantic + sized text span. CVA encodes the (size, color, weight)
 * cross-product as compile-time-checked variant keys; missing or extra
 * keys would surface as a TypeScript error rather than a silent runtime
 * fallback. Tailwind's JIT picks up the literal class strings during the
 * usual content scan.
 */
import type { Component } from "solid-js";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/cn";
import type { TextProps } from "../../primitives";

const textVariants = cva("", {
  variants: {
    size: {
      xs: "text-xs",
      sm: "text-sm",
      md: "text-base",
      lg: "text-lg",
      xl: "text-xl",
    },
    color: {
      default: "",
      muted: "text-muted-foreground",
      success: "text-success-foreground",
      warning: "text-warning-foreground",
      error: "text-error-foreground",
      accent: "text-accent-foreground",
    },
    weight: {
      normal: "",
      bold: "font-bold",
    },
  },
  defaultVariants: { size: "md", color: "default", weight: "normal" },
});

export const Text: Component<TextProps> = (props) => (
  <span
    class={cn(
      textVariants({ size: props.size, color: props.color, weight: props.weight }),
      props.class,
    )}
  >
    {props.children}
  </span>
);
