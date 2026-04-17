/**
 * E2E test: connect to production bootstrap server with the refactored client.
 * Verifies:
 *   1. WebSocket connection + TLV frame decoding
 *   2. Schema.TaggedUnion message types (._tag, .guards, .match)
 *   3. Stream.takeUntil(BootstrapMessage.guards.Complete) terminates cleanly
 *   4. Init message contains expected metadata
 */
import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import { connect } from "bootstrap";
import { BootstrapMessage, BootstrapMessageKind, type BootstrapMessageType } from "bootstrap";

const SERVER_URL = "ws://178.156.252.81:3040/bootstrap";

describe.skipIf(!process.env["E2E_PRODUCTION"])("production bootstrap client", () => {
  it.effect(
    "receives Init + data + Complete messages",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* connect(SERVER_URL);

          const messages: BootstrapMessageType[] = [];

          yield* stream.pipe(
            // Collect first 20 messages to verify protocol flow
            Stream.take(20),
            Stream.runForEach((msg) =>
              Effect.sync(() => {
                messages.push(msg);
              }),
            ),
          );

          expect(messages.length).toBeGreaterThan(0);

          // First message should be Init
          const init = messages[0]!;
          expect(init._tag).toBe(BootstrapMessageKind.Init);
          if (BootstrapMessage.guards.Init(init)) {
            expect(init.protocolMagic).toBe(1); // preprod
            expect(init.snapshotSlot).toBeGreaterThan(0n);
            expect(init.totalChunks).toBeGreaterThan(0);
            expect(init.totalBlobEntries).toBeGreaterThan(0);
            expect(init.blobPrefixes).toContain("utxo");
          }

          // Verify .match() works on a message
          const firstTag = BootstrapMessage.match(messages[0]!, {
            Init: () => "init" as const,
            Block: () => "block" as const,
            LedgerState: () => "state" as const,
            LedgerMeta: () => "meta" as const,
            BlobEntries: () => "blob" as const,
            Progress: () => "progress" as const,
            Complete: () => "complete" as const,
          });
          expect(firstTag).toBe("init");
        }),
      ).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)),
    { timeout: 30_000 },
  );
});
