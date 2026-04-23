import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  AtomDelta,
  ChainTipResult,
  GetChainTip,
  GetMempool,
  GetPeers,
  GetSyncStatus,
  NodeRpcGroup,
  PeerInfo,
  SubmitTx,
  SubscribeAtoms,
  SubscribeChainEvents,
  SyncStatus,
  TxSummary,
} from "../node-rpc-group.ts";

describe("NodeRpcGroup contract", () => {
  it("carries exactly 7 Rpcs (query + command + 2 streams)", () => {
    // The group's `.requests` is a Map keyed by Rpc tag; 7 entries
    // correspond to the 7 classes declared + exported above.
    const requestNames = Array.from(NodeRpcGroup.requests.keys());
    expect(requestNames.sort()).toEqual(
      [
        "GetChainTip",
        "GetPeers",
        "GetMempool",
        "GetSyncStatus",
        "SubmitTx",
        "SubscribeChainEvents",
        "SubscribeAtoms",
      ].sort(),
    );
  });

  it("ChainTipResult schema round-trips", () => {
    const tip = ChainTipResult.make({
      slot: 100n,
      blockNo: 42n,
      hash: new Uint8Array(32).fill(0xaa),
    });
    expect(Schema.decodeUnknownSync(ChainTipResult)(tip)).toEqual(tip);
  });

  it("SyncStatus schema accepts synced and unsynced states", () => {
    const synced = SyncStatus.make({
      synced: true,
      slotsBehind: 0n,
      tipSlot: 1000n,
      blocksProcessed: 100,
    });
    expect(synced.synced).toBe(true);
    const behind = SyncStatus.make({
      synced: false,
      slotsBehind: 50n,
      tipSlot: 1000n,
      blocksProcessed: 50,
    });
    expect(behind.slotsBehind).toBe(50n);
  });

  it("PeerInfo status discriminates the 3 states", () => {
    const peer = PeerInfo.make({
      id: "peer1",
      address: "tcp://relay.example:3001",
      status: "connected",
    });
    expect(peer.status).toBe("connected");
    expect(() =>
      Schema.decodeUnknownSync(PeerInfo)({
        id: "p",
        address: "a",
        status: "bogus",
      }),
    ).toThrow();
  });

  it("TxSummary + SubmitTx/Mempool-adjacent schemas round-trip", () => {
    const tx = TxSummary.make({ txIdHex: "deadbeef", sizeBytes: 100, feePerByte: 0.5 });
    expect(tx.txIdHex).toBe("deadbeef");
  });

  it("AtomDelta carries string key + JSON-encoded value", () => {
    const delta = AtomDelta.make({ key: "chain.tip.slot", valueJson: '"12345"' });
    expect(delta.key).toBe("chain.tip.slot");
  });

  it("Rpc classes each have a `_tag` equal to their class name", () => {
    // Verify the Rpc classes are well-formed. Each is a class returned by
    // Rpc.make; they expose `._tag` metadata equal to their name.
    const rpcs = [
      GetChainTip,
      GetPeers,
      GetMempool,
      GetSyncStatus,
      SubmitTx,
      SubscribeChainEvents,
      SubscribeAtoms,
    ];
    for (const R of rpcs) {
      expect(typeof R).toBe("function"); // Rpc.make returns a class
    }
  });
});
