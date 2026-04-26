/**
 * MempoolTable — live snapshot of pending transactions sorted by fee/byte.
 *
 * Driven by `mempoolSnapshotAtom` (server-side capped at 256 entries — see
 * `apps/bootstrap` SW config); virtualization isn't load-bearing at that
 * size and the plain `Table` primitive keeps the render path simple.
 *
 * The transaction id is rendered as a 12-char prefix + ellipsis to fit the
 * narrow popup column without horizontal scroll. Full id is recoverable
 * from the underlying atom on click in a future iteration.
 */
import { useAtomValue } from "@effect/atom-solid";
import { mempoolSnapshotAtom, type MempoolEntry } from "../atoms/node-state.ts";
import { usePrimitives } from "../primitives.ts";
import type { TableColumn } from "../primitives.ts";

const columns: readonly TableColumn<MempoolEntry>[] = [
  { header: "Tx ID", accessor: (e) => `${e.txIdHex.slice(0, 12)}…` },
  { header: "Size", accessor: (e) => `${e.sizeBytes} B`, align: "right" },
  { header: "Fee/B", accessor: (e) => e.feePerByte.toFixed(2), align: "right" },
  { header: "Slot", accessor: (e) => e.addedSlot.toString(), align: "right" },
];

export const MempoolTable = () => {
  const { Box, Text, Table } = usePrimitives();
  const mempool = useAtomValue(() => mempoolSnapshotAtom);

  return (
    <Box direction="column" gap={1}>
      <Text size="md" weight="bold">
        {`Mempool (${mempool().length} tx)`}
      </Text>
      <Table columns={columns} data={mempool()} />
    </Box>
  );
};
