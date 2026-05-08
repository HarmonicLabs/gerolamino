/**
 * Section — bold-title panel header + body slot. Standardises the
 * "header text → content" rhythm across `MempoolTable`, `PeerTable`,
 * and `ChainEventLog` so all three render identically without
 * duplicating the `<Box><Text>title</Text>...</Box>` shape per consumer.
 *
 * Heading element defaults to `<h3>` (the level used by Dashboard's
 * panel-grid) but `level` can shift it to `<h2>`–`<h6>` so consumers in
 * deeper outline contexts don't introduce a heading-level skip — screen
 * readers flag those as a structural defect during document navigation.
 */
import { Dynamic } from "solid-js/web";
import type { ParentComponent } from "solid-js";
import { cn } from "../../lib/cn";
import type { SectionProps } from "../../primitives";

export const Section: ParentComponent<SectionProps> = (props) => (
  <div class={cn("flex flex-col gap-1", props.class)}>
    <Dynamic
      component={`h${props.level ?? 3}` as const}
      class="text-base font-bold leading-none tracking-tight"
    >
      {props.title}
    </Dynamic>
    {props.children}
  </div>
);
