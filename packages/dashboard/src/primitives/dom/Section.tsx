/**
 * Section — bold-title panel header + body slot. Standardises the
 * "header text → content" rhythm across `MempoolTable`, `PeerTable`,
 * and `ChainEventLog` so all three render identically without
 * duplicating the `<Box><Text>title</Text>...</Box>` shape per consumer.
 *
 * Heading element is `<h3>` (not just a styled `<span>`) so screen
 * readers expose the section as a semantic heading in the document
 * outline.
 */
import type { ParentComponent } from "solid-js";
import { cn } from "../../lib/cn";
import type { SectionProps } from "../../primitives";

export const Section: ParentComponent<SectionProps> = (props) => (
  <div class={cn("flex flex-col gap-1", props.class)}>
    <h3 class="text-base font-bold leading-none tracking-tight">{props.title}</h3>
    {props.children}
  </div>
);
