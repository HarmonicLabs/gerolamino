/**
 * MempoolTable — live snapshot of pending transactions.
 *
 * Headless table via `@tanstack/solid-table` (v8 API):
 *   - Reactive `data` getter (`get data() { return [...memoMempool()] }`)
 *     so the atom drives table state. The spread bridges `readonly` →
 *     mutable for TanStack's `data: T[]` constraint and fires once per
 *     row-model recomputation, not per render frame.
 *   - `getRowId: row => row.txIdHex` keeps row identity stable across
 *     sorts so the virtualizer's keyed updates don't snap scroll on
 *     reorder.
 *   - Default sort: `feePerByte desc` (highest-paying first).
 *
 * Virtualization via `@tanstack/solid-virtual`:
 *   - `count` is reactive (`get count() { ... }`) so adding / removing
 *     rows reshapes the spacer without remounting.
 *   - Mempool snapshots cap at 256 rows server-side; virtualization is
 *     here because the pattern is canonical and lightweight.
 *
 * Reactive consistency: the inner `<For>` over `virtualizer.getVirtualItems()`
 * runs its callback once per virtual-item identity. The `row =
 * createMemo(() => table.getRowModel().rows[virtualRow.index])` wraps the
 * lookup in a tracking scope so a sort reorder updates the rendered row
 * even though the virtualRow identity at index N is unchanged.
 */
import { For, Show, createMemo, type Component } from "solid-js";
import { useAtomValue } from "@effect/atom-solid";
import {
  createColumnHelper,
  createSolidTable,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
} from "@tanstack/solid-table";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { mempoolSnapshotAtom, type MempoolEntry } from "../atoms/node-state.ts";
import { usePrimitives } from "../primitives.ts";

export interface MempoolTableProps {
  /** Pixel height of the scroll container. Defaults to 400. */
  readonly height?: number;
}

const columnHelper = createColumnHelper<MempoolEntry>();

// Column defs at module scope — re-defining inside the component would feed
// the table fresh references on every render and force a full reprocess.
const columns = [
  columnHelper.accessor("txIdHex", {
    header: "Tx ID",
    // 12-char prefix + ellipsis fits the narrow popup column. `es-toolkit`'s
    // `truncate` lives under `es-toolkit/compat` (lodash-compat path), and
    // the inline slice is one fewer import + same shape.
    cell: (info) => `${info.getValue().slice(0, 12)}…`,
  }),
  columnHelper.accessor("sizeBytes", {
    header: "Size",
    cell: (info) => `${info.getValue()} B`,
  }),
  columnHelper.accessor("feePerByte", {
    header: "Fee/B",
    cell: (info) => info.getValue().toFixed(2),
  }),
  columnHelper.accessor("addedSlot", {
    header: "Slot",
    cell: (info) => info.getValue().toString(),
  }),
];

export const MempoolTable: Component<MempoolTableProps> = (props) => {
  const { Section } = usePrimitives();
  const mempool = useAtomValue(() => mempoolSnapshotAtom);
  // Unify the multiple atom reads (TanStack's `get data()` getter and the
  // header's count display) into a single tracked subscription.
  const memoMempool = createMemo(() => mempool());

  const table = createSolidTable({
    get data() {
      return [...memoMempool()];
    },
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.txIdHex,
    initialState: { sorting: [{ id: "feePerByte", desc: true }] },
  });

  let scrollRef!: HTMLDivElement;

  const virtualizer = createVirtualizer({
    get count() {
      return table.getRowModel().rows.length;
    },
    getScrollElement: () => scrollRef,
    estimateSize: () => 32,
    overscan: 10,
  });

  return (
    <Section title={`Mempool (${memoMempool().length} tx)`}>
      {/* `contain: strict` lets the browser optimize the scroll container's
          layout independently — the inner translateY-positioned rows would
          otherwise trigger layout invalidation upward. */}
      <div
        ref={scrollRef}
        class="relative w-full overflow-auto rounded-md border"
        style={{ height: `${props.height ?? 400}px`, contain: "strict" }}
      >
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
          {/* `min-w-[480px]` ensures the four columns stay readable when the
              dashboard is rendered in a narrow chrome-ext popup (~380px) —
              horizontal scroll engages instead of squishing column widths. */}
          <table class="w-full min-w-[480px] caption-bottom text-sm">
            <thead class="sticky top-0 z-10 bg-card">
              <For each={table.getHeaderGroups()}>
                {(hg) => (
                  <tr class="border-b">
                    <For each={hg.headers}>
                      {(header) => {
                        const sorted = createMemo(() => header.column.getIsSorted());
                        return (
                          <th
                            class="h-10 cursor-pointer select-none px-2 text-left align-middle font-medium text-muted-foreground hover:text-foreground"
                            onClick={header.column.getToggleSortingHandler()}
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            <span>
                              {sorted() === "asc" ? " ▲" : sorted() === "desc" ? " ▼" : ""}
                            </span>
                          </th>
                        );
                      }}
                    </For>
                  </tr>
                )}
              </For>
            </thead>
            <tbody>
              <For each={virtualizer.getVirtualItems()}>
                {(virtualRow, index) => {
                  const row = createMemo(() => table.getRowModel().rows[virtualRow.index]);
                  return (
                    <Show when={row()}>
                      {(r) => (
                        <tr
                          class="border-b transition-colors hover:bg-muted/50"
                          style={{
                            height: `${virtualRow.size}px`,
                            transform: `translateY(${virtualRow.start - index() * virtualRow.size}px)`,
                          }}
                        >
                          <For each={r().getVisibleCells()}>
                            {(cell) => (
                              <td class="p-2 align-middle">
                                {flexRender(cell.column.columnDef.cell, cell.getContext())}
                              </td>
                            )}
                          </For>
                        </tr>
                      )}
                    </Show>
                  );
                }}
              </For>
            </tbody>
          </table>
        </div>
      </div>
    </Section>
  );
};
