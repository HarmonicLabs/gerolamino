/**
 * Phase 3: Byte-transparent WebSocket <-> TCP bidirectional proxy.
 */
import { BunSocket } from "@effect/platform-bun";
import { Effect } from "effect";
import type * as Socket from "effect/unstable/socket/Socket";

export const bridgeSockets = (wsSocket: Socket.Socket, upstreamUrl: globalThis.URL) =>
  Effect.scoped(
    BunSocket.makeNet({
      host: upstreamUrl.hostname,
      port: parseInt(upstreamUrl.port || "3001"),
    }).pipe(
      Effect.flatMap((tcpSocket) =>
        Effect.all(
          [
            tcpSocket.writer.pipe(
              Effect.flatMap((tcpWrite) => wsSocket.run((data) => tcpWrite(data))),
            ),
            wsSocket.writer.pipe(
              Effect.flatMap((wsWrite) => tcpSocket.run((data) => wsWrite(data))),
            ),
          ],
          { concurrency: 2 },
        ),
      ),
    ),
  );
