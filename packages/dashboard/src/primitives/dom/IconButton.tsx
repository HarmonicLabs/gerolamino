/**
 * IconButton — square Kobalte Button sized for a single icon.
 *
 * Composes from `@kobalte/core/button` directly (rather than re-exporting
 * a separate `Button` primitive) since the dashboard interface only
 * exposes the icon-only variant. The `[&_svg]:size-4` selector pins
 * lucide-solid icons to 16px regardless of their intrinsic size.
 */
import * as ButtonPrimitive from "@kobalte/core/button";
import type { Component } from "solid-js";
import { cva } from "class-variance-authority";
import { cn } from "../../lib/cn";
import type { IconButtonProps } from "../../primitives";

const iconButtonVariants = cva(
  "inline-flex size-10 items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        outline: "border border-input hover:bg-accent hover:text-accent-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export const IconButton: Component<IconButtonProps> = (props) => (
  <ButtonPrimitive.Root
    aria-label={props.ariaLabel}
    disabled={props.disabled}
    onClick={props.onClick}
    class={cn(iconButtonVariants({ variant: props.variant }), props.class)}
  >
    {props.children}
  </ButtonPrimitive.Root>
);
