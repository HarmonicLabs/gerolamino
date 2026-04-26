/**
 * Badge — pill-shape variant chip. CVA gives us a single source-of-truth
 * for the `(variant) -> classes` mapping, which keeps the variant set
 * compile-time-checked against `BadgeProps["variant"]`.
 */
import type { Component } from "solid-js";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/cn";
import type { BadgeProps } from "../../primitives";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        success: "border-success-foreground/30 bg-success text-success-foreground",
        warning: "border-warning-foreground/30 bg-warning text-warning-foreground",
        error: "border-error-foreground/30 bg-error text-error-foreground",
        outline: "border-border text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export const Badge: Component<BadgeProps> = (props) => (
  <span class={cn(badgeVariants({ variant: props.variant }), props.class)}>
    {props.children}
  </span>
);
