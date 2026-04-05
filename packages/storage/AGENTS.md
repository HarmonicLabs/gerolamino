# Agents - storage

Storage abstraction layer. Backend-agnostic.

- XState machines orchestrate block processing and mempool state.
- This is an abstraction layer - do NOT add backend-specific code (LMDB, etc.).
- State machine transitions must be tested for correctness.
- Types use Effect Schema. No `as Type`.
