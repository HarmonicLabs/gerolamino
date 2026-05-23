# Chrome extension E2E (Playwright)

How the suite maps to [Playwright](https://playwright.dev) internals and how to run it efficiently.

For **manual** Chromium QA (real directory picker, DevTools log lines, dashboard
checks), see [manual-chrome-harness.md](./manual-chrome-harness.md).

## Playwright layout (reference tree)

| Package | Role |
|---------|------|
| `packages/playwright-core` | Chromium launch, CDP, `BrowserContext`, extension flags |
| `packages/playwright` | Test runner: config, **dispatcher**, worker processes, fixtures |
| `tests/library/chromium/extensions.spec.ts` | Canonical `--load-extension` + MV3 SW pattern |
| `tests/extension/extension-fixtures.ts` | Per-test `userDataDir` via `testInfo.outputPath` |

Gerolamino mirrors the extension fixture pattern in `e2e/fixtures.ts`.

WXT org examples and cross-repo notes: [`docs/playwright-wxt-reference-audit.md`](../../../docs/playwright-wxt-reference-audit.md)
(official sample: `~/code/reference/examples/examples/playwright-e2e-testing`).

## Parallelism

Previously the suite forced `workers: 1` because of a mistaken belief that parallel persistent contexts conflict. Playwright assigns each test a **unique profile** (`testInfo.outputPath('chromium-profile')`), so workers can run in parallel safely.

| Project | Specs | Workers | Notes |
|---------|-------|---------|-------|
| `fast` | rpc, popup, setup-form, dashboard-genesis-hydration, service-worker, diag-validate | up to 4 (2 on CI) | `fullyParallel: true` |
| `ui` | `e2e/ui/*` — setup, dashboard, snapshot, a11y | parallel | headed locally; headless on CI |
| `ui-headed` | same as `ui` | parallel | always `headless: false` (local QA) |
| `upload` | upload-synthetic, diag-upload-chain, snapshot-upload | 1 | lsm-tree single-writer |
| `integration` | mithril-to-tip, sync-to-tip | 1 | depends on `fast`; relay optional |
| `manual` | bootstrap-trace, bootstrap-localhost | 1 | opt-in / legacy bootstrap |

## Commands

```sh
cd packages/chrome-ext
nix run github:0xbigboss/bun-overlay# -- x --bun wxt build --mode development
# or: bun run build:dev

# Fast smoke (parallel)
nix run github:0xbigboss/bun-overlay# -- x --bun playwright test --project=fast

# Popup UI (headed locally via `ui-headed`)
bunx --bun playwright test --project=ui
bunx --bun playwright test --project=ui-headed

# Vitest popup components (jsdom + Testing Library)
bun run test

# Upload chain only
bunx --bun playwright test --project=upload

# Mithril + sync (skips sync-to-tip if relay down)
bunx --bun playwright test --project=integration

# Full suite
bunx --bun playwright test
```

## Relay proxy

`e2e/relay-config.ts` + `e2e/global-setup.ts` probe the relay HTTP endpoint and set
`GEROLAMINO_RELAY_E2E=1` when a listener responds. Default probe is
`http://127.0.0.1:3040/`; override with `GEROLAMINO_RELAY_URL` (must match the
extension build’s `BOOTSTRAP_URL`).

**Hetzner relay-proxy** (`87.99.129.190`):

```sh
cd packages/chrome-ext
bun run build:relay-proxy
bun run e2e:relay-proxy
# headed debug zip for manual load:
bun run zip:relay-proxy
# → .output/gerolamino-*-chrome.zip (load unpacked via chrome://extensions)
```

Tests use the `relayAvailable` fixture:

- **mithril-to-tip** — seeds OPFS from `.devenv/state/db` (slim: `ledger/` + `lsm/active/` + `lsm/metadata`, ~30 MiB; skips `immutable/` and frozen `lsm/snapshots/*` blobs), then `mode:local` → relay ChainSync. Set `GEROLAMINO_USE_MINIMAL_SNAPSHOT=1` for the tiny fixture only.
- **sync-to-tip** — `mode:genesis` → relay from origin; `test.skip` when relay down.

**Local** from the repo root (devenv shell):

```sh
devenv tasks run relay:websockify
```

This runs `pkgs.python3Packages.websockify` with `--heartbeat=30`, binding
`127.0.0.1:3040` and forwarding to `preprod-node.world.dev.cardano.org:3001`
(override via `RELAY_WS_BIND` / `RELAY_TCP_TARGET` in `flake.nix` `devenv.shells.default.env`).

For a local `cardano-node` on port 3001 instead:

```sh
RELAY_TCP_TARGET=127.0.0.1:3001 devenv tasks run relay:websockify
```

## Shared helpers

`e2e/extension-helpers.ts`:

- `clearOpfsRoot` / `seedLocalSnapshotForE2e` — copy `.devenv/state/db` into OPFS (skips `immutable/`); `seedMinimalV2lsm` fallback
- `seedBootstrapSettings` — `chrome.storage.local` mode
- `waitForOffscreenDaemon(page, { deferBootstrapSync: true })` — wait for SW-managed offscreen (do **not** `goto(offscreen.html)`). `gotoOffscreen` is a deprecated alias.
- `pollUploadCompleteText` — popup completion probe (not SW logs)

## Assertion style

Per `project_sw_script_doesnt_run_in_playwright.md`: assert **popup DOM / `page.evaluate` counters**, not SW `console.log`. `readSwLogBuffer` uses `chrome.storage.session` when SW logging is required.
