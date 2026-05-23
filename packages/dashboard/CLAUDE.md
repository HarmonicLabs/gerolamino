# dashboard

Render-backend-agnostic Cardano node dashboard. Solid.js components backed
by Effect `Atom` reactive state; same component tree renders in:

- A web browser (DOM / `solid-js/web`) — `packages/dashboard/dist-spa/`
- `apps/tui` HTTP+WS host serving the SPA + optional Bun.WebView
- `packages/chrome-ext` popup (`createDomPrimitives` + delta over Port RPC)

## Structure

```
src/
  index.ts           <- barrel
  primitives.ts      <- DashboardPrimitives context (render-backend abstraction)
  primitives/dom/    <- Kobalte + Corvu + uPlot DOM adapter (`createDomPrimitives`)
  atoms/
    index.ts
    node-state.ts    <- chain tip, peer count, mempool, sync sparkline atoms
  components/
    index.ts
    Dashboard.tsx    <- top-level 3-panel layout
    NetworkPanel.tsx <- network-magic, relay, GSM
    PeerTable.tsx    <- TanStack solid-table (peers)
    MempoolTable.tsx <- TanStack table + solid-virtual (mempool)
    SyncOverview.tsx <- slot progress + bootstrap + sparkline
    ChainEventLog.tsx
  delta.ts           <- wire format (replacer/reviver, applyDelta)
  broadcast.ts       <- identity dedup broadcast fiber
  page.tsx           <- SPA entry (WS client)
  styles.css         <- Tailwind v4 tokens + uPlot import
build.ts             <- dist-spa bundle for tui host
```

## Dependencies

- `solid-js` ^1.9 — reactive renderer
- `@effect/atom-solid` — `useAtomValue` in components (workspace root)
- `effect` — `delta.ts` / `broadcast.ts` only (Schema + AtomRegistry)

Components do not import `effect` directly; hosts provide `AtomRegistry` +
`RegistryContext`.

## DashboardPrimitives abstraction

`primitives.ts` exports `PrimitivesProvider` + `DashboardPrimitives`.
Components call `usePrimitives()` only — never `@kobalte` / `@corvu` directly.
The DOM adapter is `createDomPrimitives()` in `primitives/dom/`.

## Delta wire format

`buildDeltaJson` / `applyDelta` with bigint + Uint8Array tagging. Wire shape
validated via `Schema.is(DeltaSchema)`. Do not change tag keys (`__t`, `v`)
without coordinating `apps/tui` and `packages/chrome-ext`.

## Testing

```sh
bunx --bun vitest run packages/dashboard
bunx --bun tsgo --noEmit -p packages/dashboard/tsconfig.json
bun packages/dashboard/build.ts
```

Pure wire-format tests live in `src/__tests__/delta.test.ts`.
