/**
 * Box — flex container primitive. Numeric `gap` / `padding` follow the
 * Tailwind 4-unit (0.25rem = 4px) scale via inline style; emitting them
 * as classes would require a `safelist` of every value or an explicit
 * map. Inline style is simpler and the cost is negligible.
 */
import type { ParentComponent } from "solid-js";
import { cn } from "../../lib/cn";
import type { BoxProps } from "../../primitives";

export const Box: ParentComponent<BoxProps> = (props) => (
  <div
    class={cn(
      "flex",
      props.direction === "row" ? "flex-row" : "flex-col",
      props.border && "rounded-md border border-border",
      props.class,
    )}
    style={{
      gap: props.gap != null ? `${props.gap * 4}px` : undefined,
      padding: props.padding != null ? `${props.padding * 4}px` : undefined,
      "flex-grow": props.grow,
    }}
  >
    {props.children}
  </div>
);
