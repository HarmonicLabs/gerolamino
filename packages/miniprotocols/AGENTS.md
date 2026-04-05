# Agents - miniprotocols

Ouroboros protocol implementations. Network-facing code.

- Uses WASM multiplexer from `wasm-plexer` for frame encoding.
- ChainSync uses XState state machine (Machine.ts) - understand state transitions.
- Protocol schemas are Effect Schema-based. No `as Type`.
- Network tests require internet access to preprod testnet.
- Each protocol follows Client.ts + Schemas.ts pattern.
- Path aliases: `@/*` maps to `src/*` (see tsconfig.json).
