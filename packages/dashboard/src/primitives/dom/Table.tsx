/**
 * Table — schema-driven `<table>`. Each `TableColumn<T>` declares a
 * header label + an `accessor(row) -> string|number` and an optional
 * align direction. Coerces accessor results via `String(...)` to handle
 * `bigint` / `number` cells uniformly.
 *
 * For now this is a plain HTML table. Virtualization (TanStack
 * solid-virtual) lands per-component when MempoolTable / PeerTable
 * are refactored; the primitive itself stays simple so cards inside
 * the dashboard don't pay the virtualizer cost.
 */
import { For, type JSX } from "solid-js";
import { cn } from "../../lib/cn";
import type { TableProps, TableColumn } from "../../primitives";

const alignClass = (align: TableColumn<unknown>["align"]): string =>
  align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";

export const Table = <T,>(props: TableProps<T>): JSX.Element => (
  <div class={cn("relative w-full overflow-auto", props.class)}>
    <table class="w-full caption-bottom text-sm">
      <thead>
        <tr class="border-b">
          <For each={[...props.columns]}>
            {(col) => (
              <th
                class={cn(
                  "h-10 px-2 align-middle font-medium text-muted-foreground",
                  alignClass(col.align),
                )}
              >
                {col.header}
              </th>
            )}
          </For>
        </tr>
      </thead>
      <tbody>
        <For each={[...props.data]}>
          {(row) => (
            <tr class="border-b transition-colors hover:bg-muted/50">
              <For each={[...props.columns]}>
                {(col) => (
                  <td class={cn("p-2 align-middle", alignClass(col.align))}>
                    {String(col.accessor(row))}
                  </td>
                )}
              </For>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  </div>
);
