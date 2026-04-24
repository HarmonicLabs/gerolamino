/**
 * End-to-end tests for the Handshake / KeepAlive / PeerSharing transition
 * tables wired through `TypedChannel` over paired `MockBearer`s. These are
 * the wave-2 Phase 2b deliverables — verify the agency-typed driver can
 * carry the real wire schemas across a byte boundary and survive both
 * round trips and invalid-tag injection.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { MockBearer, makeTypedChannel } from "../index.ts";
import { HandshakeMessageType } from "../../protocols/handshake/Schemas.ts";
import { MultiplexerProtocolTypeSchema } from "../../multiplexer/Schemas.ts";
import {
  handshakeTransitions,
  state_Propose,
  state_Confirm,
  tProposeVersions,
  tAcceptVersion,
} from "../../protocols/handshake/transitions.ts";
import { KeepAliveMessageType } from "../../protocols/keep-alive/Schemas.ts";
import {
  keepAliveTransitions,
  state_Client as keepAlive_state_Client,
  state_Server as keepAlive_state_Server,
  tKeepAlive,
  tKeepAliveResponse,
} from "../../protocols/keep-alive/transitions.ts";
import { PeerSharingMessageType, PeerAddressType } from "../../protocols/peer-sharing/Schemas.ts";
import {
  peerSharingTransitions,
  state_Idle as peerSharing_state_Idle,
  state_Busy as peerSharing_state_Busy,
  tShareRequest,
  tSharePeers,
} from "../../protocols/peer-sharing/transitions.ts";
import { ChainSyncMessageType } from "../../protocols/chain-sync/Schemas.ts";
import { ChainPointType } from "../../protocols/types/ChainPoint.ts";
import {
  chainSyncTransitions,
  state_Idle as chainSync_state_Idle,
  state_Intersect as chainSync_state_Intersect,
  tFindIntersect,
  tIntersectFound,
} from "../../protocols/chain-sync/transitions.ts";
import { BlockFetchMessageType } from "../../protocols/block-fetch/Schemas.ts";
import {
  blockFetchTransitions,
  state_Idle as blockFetch_state_Idle,
  state_Busy as blockFetch_state_Busy,
  state_Streaming as blockFetch_state_Streaming,
  tRequestRange,
  tStartBatch,
  tBlock,
  tBatchDone,
} from "../../protocols/block-fetch/transitions.ts";
import { TxSubmissionMessageType } from "../../protocols/tx-submission/Schemas.ts";
import {
  txSubmissionTransitions,
  state_Init as txSub_state_Init,
  state_Idle as txSub_state_Idle,
  state_TxIds as txSub_state_TxIds,
  tInit,
  tRequestTxIds,
  tReplyTxIds,
} from "../../protocols/tx-submission/transitions.ts";
import { LocalTxSubmitMessageType } from "../../protocols/local-tx-submit/Schemas.ts";
import {
  localTxSubmitTransitions,
  state_Idle as localTxSubmit_state_Idle,
  state_Busy as localTxSubmit_state_Busy,
  tSubmitTx,
  tAcceptTx,
} from "../../protocols/local-tx-submit/transitions.ts";

// ─── Handshake ───────────────────────────────────────────────────────────

describe("Handshake transitions", () => {
  it.effect("client propose → server accept round-trip", () =>
    Effect.gen(function* () {
      const { clientLayer, serverLayer } = yield* MockBearer.pair();
      const client = yield* makeTypedChannel({
        transitions: handshakeTransitions,
        side: "Client",
        initialState: state_Propose,
      });
      const server = yield* makeTypedChannel({
        transitions: handshakeTransitions,
        side: "Server",
        initialState: state_Propose,
      });

      const versionTable = {
        _tag: MultiplexerProtocolTypeSchema.enums.NodeToNode,
        data: {
          14: {
            networkMagic: 1,
            initiatorOnlyDiffusionMode: false,
            peerSharing: 1,
            query: false,
          },
          15: {
            networkMagic: 1,
            initiatorOnlyDiffusionMode: false,
            peerSharing: 1,
            query: false,
          },
        },
      } as const;

      yield* client
        .send(tProposeVersions, {
          _tag: HandshakeMessageType.MsgProposeVersions,
          versionTable,
        })
        .pipe(Effect.provide(clientLayer));

      const heardPropose = yield* server.recv(state_Propose).pipe(Effect.provide(serverLayer));
      expect(heardPropose.nextState.name).toBe("Confirm");

      yield* server
        .send(tAcceptVersion, {
          _tag: HandshakeMessageType.MsgAcceptVersion,
          version: 15,
          versionData: {
            networkMagic: 1,
            initiatorOnlyDiffusionMode: false,
            peerSharing: 1,
            query: false,
          },
        })
        .pipe(Effect.provide(serverLayer));

      const heardAccept = yield* client.recv(state_Confirm).pipe(Effect.provide(clientLayer));
      const decoded = heardAccept.message as {
        readonly _tag: HandshakeMessageType.MsgAcceptVersion;
        readonly version: number;
      };
      expect(decoded._tag).toBe(HandshakeMessageType.MsgAcceptVersion);
      expect(decoded.version).toBe(15);
      expect(heardAccept.nextState.name).toBe("Done");
      expect(heardAccept.nextState.agency).toBe("Neither");
    }),
  );
});

// ─── KeepAlive ───────────────────────────────────────────────────────────

describe("KeepAlive transitions", () => {
  it.effect("client sends MsgKeepAlive → server replies MsgKeepAliveResponse", () =>
    Effect.gen(function* () {
      const { clientLayer, serverLayer } = yield* MockBearer.pair();
      const client = yield* makeTypedChannel({
        transitions: keepAliveTransitions,
        side: "Client",
        initialState: keepAlive_state_Client,
      });
      const server = yield* makeTypedChannel({
        transitions: keepAliveTransitions,
        side: "Server",
        initialState: keepAlive_state_Client,
      });

      yield* client
        .send(tKeepAlive, { _tag: KeepAliveMessageType.KeepAlive, cookie: 42 })
        .pipe(Effect.provide(clientLayer));

      const heardKA = yield* server.recv(keepAlive_state_Client).pipe(Effect.provide(serverLayer));
      expect((heardKA.message as { cookie: number }).cookie).toBe(42);
      expect(heardKA.nextState.name).toBe("Server");

      yield* server
        .send(tKeepAliveResponse, {
          _tag: KeepAliveMessageType.KeepAliveResponse,
          cookie: 42,
        })
        .pipe(Effect.provide(serverLayer));

      const heardResponse = yield* client
        .recv(keepAlive_state_Server)
        .pipe(Effect.provide(clientLayer));
      expect((heardResponse.message as { cookie: number }).cookie).toBe(42);
      expect(heardResponse.nextState.name).toBe("Client");
      expect(heardResponse.nextState.agency).toBe("Client");
    }),
  );
});

// ─── PeerSharing ─────────────────────────────────────────────────────────

describe("PeerSharing transitions", () => {
  it.effect("client requests, server replies with peers", () =>
    Effect.gen(function* () {
      const { clientLayer, serverLayer } = yield* MockBearer.pair();
      const client = yield* makeTypedChannel({
        transitions: peerSharingTransitions,
        side: "Client",
        initialState: peerSharing_state_Idle,
      });
      const server = yield* makeTypedChannel({
        transitions: peerSharingTransitions,
        side: "Server",
        initialState: peerSharing_state_Idle,
      });

      yield* client
        .send(tShareRequest, {
          _tag: PeerSharingMessageType.ShareRequest,
          amount: 3,
        })
        .pipe(Effect.provide(clientLayer));

      const heardRequest = yield* server
        .recv(peerSharing_state_Idle)
        .pipe(Effect.provide(serverLayer));
      expect((heardRequest.message as { amount: number }).amount).toBe(3);

      const peers = [
        {
          _tag: PeerAddressType.IPv4 as const,
          addr: new Uint8Array([10, 0, 0, 1]),
          port: 3001,
        },
        {
          _tag: PeerAddressType.IPv4 as const,
          addr: new Uint8Array([10, 0, 0, 2]),
          port: 3001,
        },
      ];

      yield* server
        .send(tSharePeers, { _tag: PeerSharingMessageType.SharePeers, peers })
        .pipe(Effect.provide(serverLayer));

      const heardReply = yield* client
        .recv(peerSharing_state_Busy)
        .pipe(Effect.provide(clientLayer));
      const reply = heardReply.message as { peers: ReadonlyArray<unknown> };
      expect(reply.peers.length).toBe(2);
      expect(heardReply.nextState.name).toBe("Idle");
    }),
  );
});

// ─── ChainSync ───────────────────────────────────────────────────────────

describe("ChainSync transitions", () => {
  it.effect("FindIntersect → IntersectFound round-trip", () =>
    Effect.gen(function* () {
      const { clientLayer, serverLayer } = yield* MockBearer.pair();
      const client = yield* makeTypedChannel({
        transitions: chainSyncTransitions,
        side: "Client",
        initialState: chainSync_state_Idle,
      });
      const server = yield* makeTypedChannel({
        transitions: chainSyncTransitions,
        side: "Server",
        initialState: chainSync_state_Idle,
      });

      const hash32 = new Uint8Array(32).fill(0x11);
      const point = { _tag: ChainPointType.RealPoint as const, slot: 123, hash: hash32 };
      const tipPoint = { _tag: ChainPointType.RealPoint as const, slot: 456, hash: hash32 };

      yield* client
        .send(tFindIntersect, {
          _tag: ChainSyncMessageType.FindIntersect,
          points: [point],
        })
        .pipe(Effect.provide(clientLayer));

      const heard = yield* server.recv(chainSync_state_Idle).pipe(Effect.provide(serverLayer));
      expect(heard.nextState.name).toBe("Intersect");

      yield* server
        .send(tIntersectFound, {
          _tag: ChainSyncMessageType.IntersectFound,
          point,
          tip: { point: tipPoint, blockNo: 789 },
        })
        .pipe(Effect.provide(serverLayer));

      const reply = yield* client.recv(chainSync_state_Intersect).pipe(Effect.provide(clientLayer));
      expect((reply.message as { readonly _tag: ChainSyncMessageType })._tag).toBe(
        ChainSyncMessageType.IntersectFound,
      );
      expect(reply.nextState.name).toBe("Idle");
    }),
  );
});

// ─── BlockFetch ──────────────────────────────────────────────────────────

describe("BlockFetch transitions", () => {
  it.effect("RequestRange → StartBatch → Block(×N) → BatchDone", () =>
    Effect.gen(function* () {
      const { clientLayer, serverLayer } = yield* MockBearer.pair();
      const client = yield* makeTypedChannel({
        transitions: blockFetchTransitions,
        side: "Client",
        initialState: blockFetch_state_Idle,
      });
      const server = yield* makeTypedChannel({
        transitions: blockFetchTransitions,
        side: "Server",
        initialState: blockFetch_state_Idle,
      });

      const hash32 = new Uint8Array(32).fill(0x22);
      const blockBytes = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);

      yield* client
        .send(tRequestRange, {
          _tag: BlockFetchMessageType.RequestRange,
          from: { _tag: ChainPointType.RealPoint as const, slot: 100, hash: hash32 },
          to: { _tag: ChainPointType.RealPoint as const, slot: 105, hash: hash32 },
        })
        .pipe(Effect.provide(clientLayer));

      const heardRange = yield* server
        .recv(blockFetch_state_Idle)
        .pipe(Effect.provide(serverLayer));
      expect(heardRange.nextState.name).toBe("Busy");

      yield* server
        .send(tStartBatch, { _tag: BlockFetchMessageType.StartBatch })
        .pipe(Effect.provide(serverLayer));
      yield* client.recv(blockFetch_state_Busy).pipe(Effect.provide(clientLayer));

      // Server streams two blocks
      yield* server
        .send(tBlock, { _tag: BlockFetchMessageType.Block, block: blockBytes })
        .pipe(Effect.provide(serverLayer));
      const b1 = yield* client.recv(blockFetch_state_Streaming).pipe(Effect.provide(clientLayer));
      expect(b1.nextState.name).toBe("Streaming"); // self-loop

      yield* server
        .send(tBlock, { _tag: BlockFetchMessageType.Block, block: blockBytes })
        .pipe(Effect.provide(serverLayer));
      yield* client.recv(blockFetch_state_Streaming).pipe(Effect.provide(clientLayer));

      // BatchDone returns to Idle
      yield* server
        .send(tBatchDone, { _tag: BlockFetchMessageType.BatchDone })
        .pipe(Effect.provide(serverLayer));
      const done = yield* client.recv(blockFetch_state_Streaming).pipe(Effect.provide(clientLayer));
      expect(done.nextState.name).toBe("Idle");
    }),
  );
});

// ─── TxSubmission2 ────────────────────────────────────────────────────────

describe("TxSubmission2 transitions", () => {
  it.effect("Init → RequestTxIds → ReplyTxIds advances across agency", () =>
    Effect.gen(function* () {
      const { clientLayer, serverLayer } = yield* MockBearer.pair();
      const client = yield* makeTypedChannel({
        transitions: txSubmissionTransitions,
        side: "Client",
        initialState: txSub_state_Init,
      });
      const server = yield* makeTypedChannel({
        transitions: txSubmissionTransitions,
        side: "Server",
        initialState: txSub_state_Init,
      });

      // Client sends MsgInit to hand agency to the server
      yield* client
        .send(tInit, { _tag: TxSubmissionMessageType.Init })
        .pipe(Effect.provide(clientLayer));
      yield* server.recv(txSub_state_Init).pipe(Effect.provide(serverLayer));
      expect((yield* server.state).name).toBe("Idle");

      // Server asks for tx ids (agency moves to client)
      yield* server
        .send(tRequestTxIds, {
          _tag: TxSubmissionMessageType.RequestTxIds,
          blocking: false,
          ack: 0,
          req: 5,
        })
        .pipe(Effect.provide(serverLayer));
      yield* client.recv(txSub_state_Idle).pipe(Effect.provide(clientLayer));
      expect((yield* client.state).name).toBe("TxIds");

      // Client replies with an empty id list → agency back to server
      yield* client
        .send(tReplyTxIds, {
          _tag: TxSubmissionMessageType.ReplyTxIds,
          ids: [],
        })
        .pipe(Effect.provide(clientLayer));
      yield* server.recv(txSub_state_TxIds).pipe(Effect.provide(serverLayer));
      expect((yield* server.state).name).toBe("Idle");
    }),
  );
});

// ─── LocalTxSubmit ────────────────────────────────────────────────────────

describe("LocalTxSubmit transitions", () => {
  it.effect("SubmitTx → AcceptTx round-trip", () =>
    Effect.gen(function* () {
      const { clientLayer, serverLayer } = yield* MockBearer.pair();
      const client = yield* makeTypedChannel({
        transitions: localTxSubmitTransitions,
        side: "Client",
        initialState: localTxSubmit_state_Idle,
      });
      const server = yield* makeTypedChannel({
        transitions: localTxSubmitTransitions,
        side: "Server",
        initialState: localTxSubmit_state_Idle,
      });

      yield* client
        .send(tSubmitTx, {
          _tag: LocalTxSubmitMessageType.SubmitTx,
          tx: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
        })
        .pipe(Effect.provide(clientLayer));
      yield* server.recv(localTxSubmit_state_Idle).pipe(Effect.provide(serverLayer));
      expect((yield* server.state).name).toBe("Busy");

      yield* server
        .send(tAcceptTx, { _tag: LocalTxSubmitMessageType.AcceptTx })
        .pipe(Effect.provide(serverLayer));
      const accept = yield* client.recv(localTxSubmit_state_Busy).pipe(Effect.provide(clientLayer));
      expect(accept.nextState.name).toBe("Idle");
    }),
  );
});
