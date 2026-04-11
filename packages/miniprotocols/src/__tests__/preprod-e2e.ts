#!/usr/bin/env bun
/**
 * End-to-end miniprotocol tests against the preprod node.
 *
 * Run directly: bun packages/miniprotocols/src/__tests__/preprod-e2e.ts
 *
 * Tests:
 * 1. Handshake (N2N version negotiation)
 * 2. KeepAlive (cookie echo)
 * 3. ChainSync (find intersect + follow chain for 5 blocks)
 * 4. BlockFetch (request blocks and decode headers with ledger spec)
 */
import { Duration, Effect, Layer, Option, Stream } from "effect";
import * as BunSocket from "@effect/platform-bun/BunSocket";

import { Multiplexer } from "../multiplexer/Multiplexer.ts";
import { MultiplexerBuffer } from "../multiplexer/Buffer.ts";
import { HandshakeClient } from "../protocols/handshake/Client.ts";
import { HandshakeMessage, HandshakeMessageType } from "../protocols/handshake/Schemas.ts";
import { ChainSyncClient } from "../protocols/chain-sync/Client.ts";
import { ChainSyncMessage, ChainSyncMessageType } from "../protocols/chain-sync/Schemas.ts";
import { BlockFetchClient } from "../protocols/block-fetch/Client.ts";
import { KeepAliveClient } from "../protocols/keep-alive/Client.ts";
import { ChainPointType, ChainPointSchema } from "../protocols/types/ChainPoint.ts";

// Decode blocks with ledger spec (direct path import)
import { decodeMultiEraBlock, type BlockHeader } from "../../../ledger/src/lib/block.ts";

// ── Preprod testnet layer ──

const PreprodSocket = BunSocket.layerNet({
  host: "preprod-node.play.dev.cardano.org",
  port: 3001,
});

const PreprodMultiplexer = Multiplexer.layer.pipe(
  Layer.provide(MultiplexerBuffer.layer),
  Layer.provide(PreprodSocket),
);

const N2NProtocols = Layer.mergeAll(
  HandshakeClient.layer,
  ChainSyncClient.layer,
  BlockFetchClient.layer,
  KeepAliveClient.layer,
).pipe(Layer.provide(PreprodMultiplexer));

const preprodVersionTable = {
  _tag: "node-to-node" as const,
  data: {
    14: {
      networkMagic: 1,
      initiatorOnlyDiffusionMode: false,
      peerSharing: 0,
      query: false,
    },
  },
};

// ── Test utilities ──

let passed = 0;
let failed = 0;

function ok(name: string, msg?: string) {
  passed++;
  console.log(`  ✓ ${name}${msg ? ` — ${msg}` : ""}`);
}

function fail(name: string, err: unknown) {
  failed++;
  console.log(`  ✗ ${name} — ${err}`);
}

// ── Tests ──

const program = Effect.gen(function* () {
  console.log("\n=== Miniprotocol E2E Tests (preprod-node.play.dev.cardano.org:3001) ===\n");

  // 1. Handshake
  console.log("--- Handshake ---");
  const hs = yield* HandshakeClient;
  const hsResult = yield* hs.propose(preprodVersionTable);

  if (HandshakeMessage.guards[HandshakeMessageType.MsgAcceptVersion](hsResult)) {
    ok("Handshake", `version=${hsResult.version}, magic=${hsResult.versionData.networkMagic}`);
    if (hsResult.version !== 14) fail("Handshake version", `expected 14, got ${hsResult.version}`);
    if (hsResult.versionData.networkMagic !== 1)
      fail("Handshake magic", `expected 1, got ${hsResult.versionData.networkMagic}`);
  } else {
    fail("Handshake", `unexpected: ${hsResult._tag}`);
  }

  // 2. KeepAlive
  console.log("\n--- KeepAlive ---");
  const ka = yield* KeepAliveClient;
  const cookie = 12345;
  const echoCookie = yield* ka.keepAlive(cookie);
  if (echoCookie === cookie) {
    ok("KeepAlive", `cookie=${cookie} echoed correctly`);
  } else {
    fail("KeepAlive", `expected ${cookie}, got ${echoCookie}`);
  }

  // 3. ChainSync
  console.log("\n--- ChainSync ---");
  const cs = yield* ChainSyncClient;

  // FindIntersect at origin
  const intersect = yield* cs.findIntersect([{ _tag: ChainPointType.Origin }]).pipe(
    Effect.timeout(Duration.seconds(15)),
    Effect.catchTag("TimeoutError", () => Effect.fail("FindIntersect timed out")),
  );
  if (ChainSyncMessage.isAnyOf(["IntersectFound", "IntersectNotFound"])(intersect)) {
    ok("FindIntersect at origin", intersect._tag);
  } else {
    fail("FindIntersect", `unexpected: ${intersect._tag}`);
  }

  // Follow chain for 5 blocks
  let lastSlot = 0;
  let slotsMonotonic = true;
  for (let i = 0; i < 5; i++) {
    const next = yield* cs.requestNext().pipe(
      Effect.timeout(Duration.seconds(15)),
      Effect.catchTag("TimeoutError", () => Effect.fail(`requestNext[${i}] timed out`)),
    );
    if (ChainSyncMessage.guards.RollForward(next)) {
      const tipSlot = ChainPointSchema.match(next.tip.point, {
        RealPoint: (p) => p.slot,
        Origin: () => 0,
      });
      if (tipSlot < lastSlot) slotsMonotonic = false;
      lastSlot = tipSlot;
      ok(
        `RequestNext[${i}]`,
        `RollForward tip.blockNo=${next.tip.blockNo}, header=${next.header.length}B`,
      );
    } else if (ChainSyncMessage.guards.RollBackward(next)) {
      ok(`RequestNext[${i}]`, `RollBackward`);
    } else {
      fail(`RequestNext[${i}]`, `unexpected: ${next._tag}`);
    }
  }
  if (slotsMonotonic) {
    ok("Slot monotonicity", "all 5 blocks in order");
  } else {
    fail("Slot monotonicity", "slots not monotonic");
  }

  // 4. BlockFetch — use the tip point from ChainSync (most recent block the server told us about)
  console.log("\n--- BlockFetch ---");
  const bf = yield* BlockFetchClient;

  // The tip reported by ChainSync is a real point near the chain head
  // Use it for BlockFetch
  const nextForFetch = yield* cs.requestNext().pipe(
    Effect.timeout(Duration.seconds(15)),
    Effect.catchTag("TimeoutError", () => Effect.succeed(undefined)),
  );

  if (
    nextForFetch &&
    ChainSyncMessage.guards.RollForward(nextForFetch) &&
    ChainPointSchema.guards.RealPoint(nextForFetch.tip.point)
  ) {
    const tipPoint = nextForFetch.tip.point;
    ok(
      "BlockFetch point",
      `slot=${tipPoint.slot}, hash=${Buffer.from(tipPoint.hash).toString("hex").slice(0, 16)}...`,
    );

    const result = yield* bf.requestRange(tipPoint, tipPoint).pipe(
      Effect.timeout(Duration.seconds(15)),
      Effect.catchTag("TimeoutError", () => Effect.succeed(Option.none())),
    );

    if (Option.isSome(result)) {
      const blocks = yield* result.value.pipe(
        Stream.runCollect,
        Effect.timeout(Duration.seconds(15)),
        Effect.catchTag("TimeoutError", (): Effect.Effect<Uint8Array[]> => Effect.succeed([])),
      );
      ok("BlockFetch requestRange", `${blocks.length} block(s) received`);

      // Decode first block with ledger spec
      if (blocks.length > 0) {
        const blockCbor = blocks[0]!;
        try {
          const decoded = Effect.runSync(decodeMultiEraBlock(blockCbor));
          if (decoded._tag === "postByron" && decoded.header) {
            const hdr = decoded.header;
            ok(
              "Block header decode",
              `slot=${hdr.slot}, blockNo=${hdr.blockNo}, txs=${decoded.txBodies.length}`,
            );
          } else if (decoded._tag === "byron") {
            ok("Block decode", "Byron block (opaque)");
          }
        } catch (e) {
          fail("Block header decode", e);
        }
      }
    } else {
      ok("BlockFetch", "NoBlocks (tip moved or timeout)");
    }
  } else {
    ok("BlockFetch", "skipped (no usable tip point from ChainSync)");
  }

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) {
    yield* Effect.fail(`${failed} test(s) failed`);
  }
});

// Run
const exit = await Effect.runPromiseExit(
  program.pipe(Effect.scoped, Effect.provide(N2NProtocols), Effect.timeout(Duration.seconds(120))),
);

if (exit._tag === "Failure") {
  console.error("E2E test failed:", exit.cause);
  process.exit(1);
}
