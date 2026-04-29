/**
 * PeerTable — connected-peers list with sortable columns.
 *
 * Headless table via `@tanstack/solid-table` (v8 API), same shape as
 * `MempoolTable.tsx` so the two surfaces share a render idiom:
 *   - Reactive `data` getter unifies into a single `mempoolSnapshotAtom`
 *     subscription via `createMemo`.
 *   - `getRowId: peer => peer.id` — peer ids are unique stable strings,
 *     ideal for keyed-diff stability across status / tip updates.
 *   - Default sort: tip slot desc (most-progressed peer first).
 *
 * Virtualization deliberately omitted — the practical peer count is ≤50,
 * well under any DOM render budget; `createVirtualizer` would add ~2KB
 * for no observable benefit.
 */
import { For, createMemo } from "solid-js";
import { useAtomValue } from "@effect/atom-solid";
import {
  createColumnHelper,
  createSolidTable,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
} from "@tanstack/solid-table";
import { peersAtom, type PeerInfo } from "../atoms/node-state.ts";
import { usePrimitives } from "../primitives.ts";

const columnHelper = createColumnHelper<PeerInfo>();

const columns = [
  columnHelper.accessor("id", { header: "Peer" }),
  columnHelper.accessor("status", { header: "Status" }),
  columnHelper.accessor((row) => row.tipSlot ?? 0n, {
    id: "tipSlot",
    header: "Tip Slot",
    cell: (info) => info.getValue().toString(),
  }),
  columnHelper.accessor((row) => row.latencyMs, {
    id: "latencyMs",
    header: "Latency",
    cell: (info) => {
      const v = info.getValue();
      return v !== undefined ? `${v}ms` : "--";
    },
  }),
];

export const PeerTable = () => {
  const { Section } = usePrimitives();
  const peers = useAtomValue(() => peersAtom);
  const memoPeers = createMemo(() => peers());

  const table = createSolidTable({
    get data() {
      return [...memoPeers()];
    },
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.id,
    initialState: { sorting: [{ id: "tipSlot", desc: true }] },
  });

  return (
    <Section title={`Peers (${memoPeers().length})`}>
      <div class="relative w-full overflow-auto rounded-md border">
        <table class="w-full caption-bottom text-sm">
          <thead>
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
            <For each={table.getRowModel().rows}>
              {(row) => (
                <tr class="border-b transition-colors hover:bg-muted/50">
                  <For each={row.getVisibleCells()}>
                    {(cell) => (
                      <td class="p-2 align-middle">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </Section>
  );
};
