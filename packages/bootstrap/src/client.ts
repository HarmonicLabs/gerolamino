/**
 * Effect-TS WebSocket bootstrap client.
 * Returns a typed Stream<BootstrapMessage> from a bootstrap server connection.
 * Uses socket.run + Queue for push-to-pull stream bridging.
 */
import { Effect, Queue, Stream } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import {
  type BootstrapMessage, concatBytes, extractFrames, decodeFrame,
} from "./protocol.ts"

// Frame reassembly state
interface FrameState {
  readonly buffer: Uint8Array
  readonly frames: ReadonlyArray<Uint8Array>
}

const emptyFrameState: FrameState = { buffer: new Uint8Array(0), frames: [] }

/**
 * Connect to a bootstrap server and return a stream of decoded messages.
 * The socket's push-based handler feeds a Queue; Stream.fromQueue pulls from it.
 */
export const connect = (url: string) =>
  Effect.gen(function*() {
    const socket = yield* Socket.makeWebSocket(url)
    const queue = yield* Queue.unbounded<Uint8Array>()

    // Fork socket runner: pushes received bytes into queue, shuts down on close
    yield* Effect.forkScoped(
      socket.run(
        (data: Uint8Array) => Queue.offer(queue, data),
      ).pipe(
        Effect.ensuring(Queue.shutdown(queue)),
      ),
    )

    // Stream from queue with TLV frame reassembly and message decoding
    const byteStream: Stream.Stream<Uint8Array> = Stream.fromQueue(queue)

    return byteStream.pipe(
      Stream.scan(emptyFrameState, (state: FrameState, chunk: Uint8Array): FrameState => {
        const combined = concatBytes(state.buffer, chunk)
        const result = extractFrames(combined)
        return { buffer: result.remaining, frames: result.frames }
      }),
      Stream.flatMap((state: FrameState) => Stream.fromIterable(state.frames)),
      Stream.map(decodeFrame),
    )
  })
