/**
 * Effect-TS WebSocket bootstrap client.
 * Returns a typed Stream<BootstrapMessage> from a bootstrap server connection.
 */
import { Effect, Queue, Stream } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import { BootstrapMessage } from "./protocol.ts";
import { decodeStream } from "./codec.ts";

/**
 * Connect to a bootstrap server and return a stream of decoded messages.
 * The socket's push-based handler feeds a Queue; Stream.fromQueue pulls from it.
 * Frame reassembly and decoding are handled by decodeStream (Stream.mapAccum).
 */
export const connect = (url: string) =>
  Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(url);
    const queue = yield* Queue.unbounded<Uint8Array>();

    yield* Effect.forkScoped(
      socket
        .run((data: Uint8Array) => Queue.offer(queue, data))
        .pipe(Effect.ensuring(Queue.shutdown(queue))),
    );

    return decodeStream(Stream.fromQueue(queue)).pipe(
      Stream.takeUntil(BootstrapMessage.guards.Complete),
    );
  });
