# Agents - bootstrap (package)

Pure protocol client. Keep dependencies minimal.

- This is NOT the server. The server is `apps/bootstrap/`.
- Uses Effect for async operations. No Bun-specific APIs.
- Errors use `Schema.TaggedErrorClass`.
- Do not add ledger, cbor-schema, or storage dependencies here.
