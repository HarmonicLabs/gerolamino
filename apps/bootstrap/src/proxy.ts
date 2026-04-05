/**
 * Phase 3: Byte-transparent WebSocket <-> TCP bidirectional proxy.
 */
import { BunSocket } from "@effect/platform-bun";
import { Effect } from "effect";
import type * as Socket from "effect/unstable/socket/Socket";

export const bridgeSockets = (wsSocket: Socket.Socket, upstreamUrl: globalThis.URL) =>
  Effect.scoped(
    Effect.gen(function* () {
      const tcpSocket = yield* BunSocket.makeNet({
        host: upstreamUrl.hostname,
        port: parseInt(upstreamUrl.port || "3001"),
      });
      const tcpWrite = yield* tcpSocket.writer;
      const wsWrite = yield* wsSocket.writer;
      yield* Effect.all(
        [wsSocket.run((data) => tcpWrite(data)), tcpSocket.run((data) => wsWrite(data))],
        { concurrency: 2 },
      );
    }),
  );
