/**
 * Raw browser WebSocket bootstrap client.
 * Zero Effect dependency - uses only native browser APIs.
 * Returns an AsyncGenerator of decoded BootstrapMessage.
 */
import {
  type BootstrapMessage, concatBytes, extractFrames, decodeFrame,
} from "./protocol.ts"

/**
 * Connect to a bootstrap server and yield decoded messages as an async generator.
 * Works in any browser environment without Effect-TS.
 */
export async function* connectRaw(url: string): AsyncGenerator<BootstrapMessage> {
  const ws = new WebSocket(url)
  ws.binaryType = "arraybuffer"

  const pending: ArrayBuffer[] = []
  let resolve: (() => void) | null = null
  let done = false
  let error: Event | null = null

  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) pending.push(e.data)
    resolve?.()
  }
  ws.onclose = () => {
    done = true
    resolve?.()
  }
  ws.onerror = (e) => {
    error = e
    done = true
    resolve?.()
  }

  // Wait for connection
  await new Promise<void>((r, reject) => {
    ws.onopen = () => r()
    ws.onerror = (e) => reject(new Error(`WebSocket connection failed: ${e}`))
  })

  let buffer: Uint8Array = new Uint8Array(0)

  while (!done || pending.length > 0) {
    if (pending.length === 0) {
      await new Promise<void>((r) => { resolve = r })
      resolve = null
      continue
    }

    const raw = new Uint8Array(pending.shift()!)
    const combined = concatBytes(buffer, raw)
    const { frames, remaining } = extractFrames(combined)
    buffer = remaining

    for (const frame of frames) {
      yield decodeFrame(frame)
    }
  }

  if (error) {
    throw new Error(`WebSocket error during bootstrap`)
  }
}
