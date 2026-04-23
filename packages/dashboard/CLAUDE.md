# dashboard

Render-backend-agnostic Cardano node dashboard. Solid.js components backed
by Effect `Atom` reactive state; same component tree renders in:
- A web browser (DOM / `solid-js/web`)
- Bun.WebView in apps/tui (future Phase 5 — Kitty-graphics screenshot loop)

## Structure

```
src/
  index.ts           <- barrel
  primitives.ts      <- DashboardPrimitives context (render-backend abstraction)
  atoms/
    index.ts
    node-state.ts    <- chain tip, peer count, mempool size, sync progress atoms
  components/
    index.ts
    Dashboard.tsx    <- top-level layout
    NetworkPanel.tsx <- network-magic, tip, sync status
    PeerTable.tsx    <- per-peer rows
    SyncOverview.tsx <- slot progress + GSM state
```

## Dependencies

- `solid-js` ^1.9.12 — reactive renderer (the Atom bridge lives in
  `@effect/atom-solid` when it's added; until then the atoms expose their
  raw `Atom<A>` for manual bridging).

Intentionally NOT depending on:
- `effect` directly — atoms are consumed as opaque read-only handles;
  consumers (apps/tui, browser bundle) provide the AtomRegistry Layer.
- Any HTTP / WS client — remote data flows in through the parent's Layer.

## DashboardPrimitives abstraction

`primitives.ts` exports a `PrimitivesProvider` Solid context + a
`DashboardPrimitives` type. Consumers implement the type per backend:
- Browser: DOM nodes via `solid-js/web`
- OpenTUI (deprecated): terminal glyph primitives
- Bun.WebView (future): DOM nodes inside the WebView

Components never touch a render API directly — they call into the
primitives context, which the backend-specific adapter supplies.

## Current consumers

- `apps/tui/src/dashboard/` renders this package via the OpenTUI adapter
  (scheduled for replacement by Bun.WebView + DOM adapter in Phase 5).
- `packages/chrome-ext` (deferred) would consume the DOM adapter directly.

## Testing

No tests currently ship with this package — dashboard behaviour is
exercised through `apps/tui`'s integration tests once the WebView rendering
wave lands. Unit tests for pure components + atom helpers welcome, but
aren't load-bearing for the plan's current phase.
