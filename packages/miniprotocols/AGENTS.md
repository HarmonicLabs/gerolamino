# Agents - miniprotocols

Ouroboros protocol implementations. Network-facing code.

- Uses WASM multiplexer from `wasm-plexer` for frame encoding.
- Protocol clients are Stream / Channel / PubSub native (no XState; `chain-sync/Machine.ts` was removed).
- Protocol schemas are Effect Schema-based. No `as Type`.
- Network tests require internet access to preprod testnet.
- Each protocol follows Client.ts + Schemas.ts pattern.
- Path aliases: `@/*` maps to `src/*` (see tsconfig.json).
