/**
 * SortableTh — shared sortable `<th>` for TanStack solid-table panels.
 *
 * Centralises `aria-sort`, keyboard activation (Enter/Space), and the
 * sort-direction glyph so `PeerTable` and `MempoolTable` stay aligned.
 */
import { createMemo } from "solid-js";
import { flexRender, type Header } from "@tanstack/solid-table";
import { ariaSortValue, sortIndicator } from "../lib/sortable-table.ts";

export interface SortableThProps<T> {
  readonly header: Header<T, unknown>;
}

export function SortableTh<T>(props: SortableThProps<T>) {
  const sorted = createMemo(() => props.header.column.getIsSorted());

  const onActivate = (event: unknown) => {
    props.header.column.getToggleSortingHandler()?.(event);
  };

  return (
    <th
      scope="col"
      class="h-10 cursor-pointer select-none px-2 text-left align-middle font-medium text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      aria-sort={ariaSortValue(sorted())}
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate(e);
        }
      }}
    >
      {flexRender(props.header.column.columnDef.header, props.header.getContext())}
      <span aria-hidden="true">{sortIndicator(sorted())}</span>
    </th>
  );
}
