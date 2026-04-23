import { describe, expect, it } from "@effect/vitest";
import { Effect, Metric } from "effect";
import {
  BlockAccepted,
  BlockValidationFailed,
  ChainLength,
  ChainTipSlot,
  EpochBoundaryCount,
  PeerCount,
  PeerStalledCount,
  RollbackCount,
  SPAN,
} from "../observability.ts";

describe("consensus/observability", () => {
  it("SPAN names are pairwise distinct", () => {
    const staticNames = [
      SPAN.ValidateHeader,
      SPAN.ValidateBody,
      SPAN.ChainSelect,
      SPAN.ChainRollback,
      SPAN.PeerConnect,
      SPAN.PeerDisconnect,
      SPAN.PeerStalled,
    ];
    const activitySpans = ["DiscoverPeers", "SpawnPeerFibers", "StartChainWorker"].map(
      SPAN.BlockSyncActivity,
    );
    const all = [...staticNames, ...activitySpans];
    expect(new Set(all).size).toBe(all.length);
  });

  it("every SPAN name starts with the 'consensus.' prefix", () => {
    const staticNames = [
      SPAN.ValidateHeader,
      SPAN.ValidateBody,
      SPAN.ChainSelect,
      SPAN.ChainRollback,
      SPAN.PeerConnect,
      SPAN.PeerDisconnect,
      SPAN.PeerStalled,
    ];
    for (const name of staticNames) {
      expect(name).toMatch(/^consensus\./);
    }
    expect(SPAN.BlockSyncActivity("foo")).toBe("consensus.blocksync.foo");
  });

  it.effect("counters accept updates without throwing", () =>
    Effect.gen(function* () {
      yield* Metric.update(BlockAccepted, 1);
      yield* Metric.update(BlockValidationFailed, 1);
      yield* Metric.update(RollbackCount, 1);
      yield* Metric.update(EpochBoundaryCount, 1);
      yield* Metric.update(PeerStalledCount, 1);
      // Peer count is a gauge; accepts absolute values
      yield* Metric.update(PeerCount, 5);
      // Bigint gauges accept bigint
      yield* Metric.update(ChainTipSlot, 1000n);
      yield* Metric.update(ChainLength, 42n);
    }),
  );
});
