/**
 * ScrollArea — bounded vertical scroll container. Plain native scroll
 * for now; the styling tweaks (rounded thumb, subtle track) are applied
 * via the global `::-webkit-scrollbar` rule in `styles.css`.
 *
 * Numeric `maxHeight` is treated as pixels; string is passed through.
 */
import type { ParentComponent } from "solid-js";
import { cn } from "../../lib/cn";
import type { ScrollAreaProps } from "../../primitives";

export const ScrollArea: ParentComponent<ScrollAreaProps> = (props) => (
  <div
    class={cn("overflow-y-auto", props.class)}
    style={{
      "max-height":
        typeof props.maxHeight === "number"
          ? `${props.maxHeight}px`
          : (props.maxHeight ?? undefined),
    }}
  >
    {props.children}
  </div>
);
