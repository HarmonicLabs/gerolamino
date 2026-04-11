/**
 * NetworkPanel — shows network configuration and connection info.
 * Platform-agnostic: renders via DashboardPrimitives context.
 */
import { useAtomValue } from "@effect/atom-solid";
import { networkInfoAtom, nodeStateAtom } from "../atoms/node-state.ts";
import { usePrimitives } from "../primitives.ts";

export const NetworkPanel = () => {
  const { Box, Text, Badge, Stat, Card } = usePrimitives();
  const network = useAtomValue(networkInfoAtom);
  const state = useAtomValue(nodeStateAtom);

  return (
    <Card title="Network">
      <Box direction="column" gap={1}>
        <Box direction="row" gap={1}>
          <Badge variant="outline">{network().network}</Badge>
          <Text size="sm" color="muted">
            magic {network().protocolMagic}
          </Text>
        </Box>
        <Stat
          label="Relay"
          value={network().relayHost ? `${network().relayHost}:${network().relayPort}` : "--"}
        />
        <Stat
          label="GSM"
          value={state().gsmState}
          description={
            state().gsmState === "CaughtUp" ? "Node is synchronized" : "Catching up to tip"
          }
        />
      </Box>
    </Card>
  );
};
