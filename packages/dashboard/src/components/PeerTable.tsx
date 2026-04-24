/**
 * PeerTable — displays connected peers with status and latency.
 * Platform-agnostic: renders via DashboardPrimitives context.
 */
import { useAtomValue } from "@effect/atom-solid";
import { peersAtom } from "../atoms/node-state.ts";
import { usePrimitives } from "../primitives.ts";
import type { PeerInfo } from "../atoms/node-state.ts";
import type { TableColumn } from "../primitives.ts";

const columns: readonly TableColumn<PeerInfo>[] = [
  { header: "Peer", accessor: (p) => p.id },
  { header: "Status", accessor: (p) => p.status },
  { header: "Tip Slot", accessor: (p) => (p.tipSlot ?? 0n).toString(), align: "right" },
  { header: "Latency", accessor: (p) => (p.latencyMs ? `${p.latencyMs}ms` : "--"), align: "right" },
];

export const PeerTable = () => {
  const { Box, Text, Table } = usePrimitives();
  const peers = useAtomValue(() => peersAtom);

  return (
    <Box direction="column" gap={1}>
      <Text size="md" weight="bold">
        Peers
      </Text>
      <Table columns={columns} data={peers()} />
    </Box>
  );
};
