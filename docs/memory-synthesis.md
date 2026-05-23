# Claude memory bank — synthesis for Cursor

Index: `~/.claude/projects/-home-hariamoor-code-HarmonicLabs-gerolamino/memory/MEMORY.md` (187 files).

This document distills load-bearing findings from the May 2026 release loop. Read alongside [`cursor-handoff.md`](cursor-handoff.md).

**Effect v4 polish waves** (subagents): start with [`effect-v4-coding-standards.md`](effect-v4-coding-standards.md) and the per-package pre-audit in [`effect-v4-package-audits.md`](effect-v4-package-audits.md) before spawning `.cursor/agents/*-effect-v4` agents.

## Architecture (landed — do not regress)

| Brief (historical) | Landed reality |
|--------------------|----------------|
| IndexedDB / SQLite chain storage | **BlobStore-only** — OPFS + Haskell `lsm-tree` WASM in dedicated Worker |
| Native messaging | `chrome.runtime.Port` + BroadcastChannel + MessageChannel |
| Bootstrap HTTP/WS server | **Deleted** — drag-drop V2LSM + optional relay WS proxy |
| SW runs consensus | **Offscreen** (`WORKERS` reason) is the indefinite daemon; SW is RPC gateway |

Critical offscreen invariants (`project_chrome_offscreen_step5_e2e_findings.md`):

- `Effect.forkScoped` + trailing `Effect.never` — never `Effect.scoped` on the outer program alone (tears down RpcServer).
- `RpcSerialization.layerNdjson` on **both** BroadcastChannel ends.
- Single shared `LsmWorkerBrowser` in `runtimeLayer` (two Workers corrupt OPFS).

## Effect v4 landmines (`project_chrome_ext_release_blockers.md`)

Removed APIs become `(void 0)` at Rolldown bundle time — **silent SW crash**:

- `Context.Tag` → `Context.Service`
- `Effect.zipRight` → `Effect.andThen`
- `Effect.tapErrorCause` → `Effect.tapCause`
- `Schedule.upTo` — removed
- `Predicate.isRecord` → `Predicate.isObject`
- `Layer.provide([...])` does not compose array elements
- `RpcSerialization.layerNdjson` required even on BroadcastChannel

Gate: `nix run github:0xbigboss/bun-overlay#bun -- x --bun tsgo --noEmit -p packages/chrome-ext/tsconfig.json`

## LSM upload / Playwright (`project_synthetic_spec_worker_logs.md`)

Production upload path works (`diag-upload-chain`, manual drag-drop). Playwright failures are **orchestration**, not logic regressions.

| Finding | Action taken |
|---------|----------------|
| `Pool` + listener retry spawns >1 Worker | `Pool.make({ size: 1 })` + **singleton** `spawnLsmWorker` in `lsm-pool.ts` |
| Per-path OPFS handle races | `writeChunk` per-path queue + `chunkInFlight` join on `path:offset` in `lsm-worker.ts` |
| SW `relayRetry` / `relayLong` retry cascades | `relayUpload` (180s, **no retries**) for upload + reopen |
| Duplicate RPC dispatches | Join at worker (`chunkInFlight`), not skip-at-handler |
| Bootstrap contends with upload | E2E: `offscreen.html?deferBootstrapSync=1`; production: `StartSync` after upload |
| `promoteToImmutable` before session open | Guard on `ingest !== undefined` in monitor loop |
| `pollUntil(60_000)` too tight | `upload-synthetic.spec.ts` → 180s; `test.setTimeout(240_000)` |

Hypotheses **refuted** (`project_upload_synthetic_hypotheses_refuted.md`): bootstrap-sync pool starvation; cross-run OPFS lock retention (fresh persistent context per test).

## Dashboard sync (`reference_effect_atoms.md`, TUI pattern)

Offscreen must mirror TUI (`apps/tui/src/index.ts`):

1. `ChainEventStream` → `appendChainEvent` (feeds `chainEventLogAtom` / Events tab)
2. Monitor loop → `pushNodeState`, `pushPeers`, `pushSyncSparklinePoint`
3. `broadcast.ts` 100ms fiber → `SubscribeAtomDeltas` → popup `applyDelta`

**Do not** assert Playwright success via SW `console.log` (`project_sw_script_doesnt_run_in_playwright.md`) — use popup DOM / atom-driven text (tip slot, sync %, Events tab).

## Mithril bootstrap gaps (`project_mithril_bootstrap_extraction_gaps.md`)

Only `LedgerView` + `Nonces` + tip extracted from `ExtLedgerState`. UTxOs live in uploaded LSM session (not in CBOR gap).

Post-v0.1.0 priority:

1. Treasury / reserves (2 BigInts) — simplest dashboard win
2. Pool params → `putBatch`
3. Stake accounts (~1M preprod) — streaming batches
4. Snapshot history, governance — larger

Genesis fallback on decode failure is intentional for dummy E2E CBOR; **fail loud** on real snapshot decode errors in production.

## Bun / Nix (`reference_bun_overlay_glibc.md`)

- CI / chrome-ext: `nix run github:0xbigboss/bun-overlay#bun -- ...`
- TUI + WASM lsm-tree: `nix run .#bun -- ...` (glibc 2.42 match via bun-overlay follows)
- Devenv `languages.javascript.bun.package` may still lose to nixpkgs 1.3.11 on PATH — backlog

## Release status (`project_release_readiness_may_2026.md`)

Green at `724ca2df`: 11/11 type-check, 1277 vitest, TUI live preprod, chrome upload to worker boundary.

Remaining for tag: Playwright upload-synthetic green; validating ledger rules (separate milestone); optional Mithril field extraction.

## Where to read next

| Topic | Memory file |
|-------|-------------|
| Upload hang diagnosis | `project_upload_synthetic_hang_localized.md` |
| Worker logs + relayLong | `project_synthetic_spec_worker_logs.md` |
| Offscreen scope bug | `project_chrome_offscreen_step5_e2e_findings.md` |
| es-toolkit catalog | `reference_es_toolkit_catalog.md` |
| Effect v4 API | `reference_effect_v4_api_changes.md` |
| Test coverage ship list | `reference_test_coverage_gaps.md` |
