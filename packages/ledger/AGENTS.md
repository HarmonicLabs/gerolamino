# Agents - ledger

Critical package. Decodes all Cardano eras (Byron through Conway).

- Use `Schema.TaggedClass` for all domain types that need methods.
- Never use `as Type`. Decode via Schema pipelines.
- Hash types should use Schema-based constructors, not string brands.
- Test changes against the full snapshot decode if touching block/tx decoders.
- Cross-package imports from codecs use the path alias, not relative paths.
- WASM crypto is loaded from `wasm-utils` (blake2b, ed25519, KES, bech32).
