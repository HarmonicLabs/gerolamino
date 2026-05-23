# WXT / Playwright reference audit (`wxt-dev/examples`)

Deep read of `~/code/reference/examples` (wxt-dev org) and upstream Playwright
extension fixtures, mapped to Gerolamino `packages/chrome-ext/e2e`.

## Canonical sources

| Source | What it teaches |
|--------|-----------------|
| [wxt-dev/examples `playwright-e2e-testing`](https://github.com/wxt-dev/examples/tree/main/examples/playwright-e2e-testing) | Official WXT E2E sample: `launchPersistentContext`, `--load-extension`, MV3 `serviceworker` wait, `extensionId` from SW URL |
| [WXT e2e-testing guide](https://wxt.dev/guide/essentials/e2e-testing.html) | Points at the example + Playwright Chrome Extension docs; output dir `.output/chrome-mv3` |
| `~/code/reference/playwright/tests/library/chromium/extensions.spec.ts` | `--disable-extensions-except` + `launchPersistentContext('')` |
| `~/code/reference/playwright/tests/extension/extension-fixtures.ts` | Per-test `testInfo.outputPath('extension-user-data-dir')`, `headless: false`, `ignoreDefaultArgs: ['--enable-automation']`, lazy MV3 SW wait |
| `examples/offscreen-document-setup` | Minimal `browser.offscreen.createDocument` from SW |
| `examples/offscreen-document-domparser` | Offscreen entry lifecycle (no Playwright) |

WXT’s own `packages/wxt/e2e/utils.ts` is for **WXT package** unit/e2e (ephemeral
`TestProject` dirs), not browser extension Playwright — not applicable to
Gerolamino runtime tests.

## WXT `playwright-e2e-testing` pattern (minimal)

```typescript
// e2e/fixtures.ts (reference)
chromium.launchPersistentContext("", {
  headless: false,
  args: [
    `--disable-extensions-except=${pathToExtension}`,
    `--load-extension=${pathToExtension}`,
  ],
});
// extensionId: context.serviceWorkers()[0] ?? waitForEvent("serviceworker")
// popup: page.goto(`chrome-extension://${extensionId}/popup.html`)
```

**Intentionally absent** in the WXT sample: offscreen documents, dedicated
workers, OPFS, BroadcastChannel RPC, storage seeding, relay proxies.

## Gerolamino alignment

| Pattern | WXT example | Gerolamino `e2e/fixtures.ts` |
|---------|-------------|------------------------------|
| Persistent context + load flags | Yes | Yes (`EXTENSION_PATH` = `chrome-mv3-dev`) |
| MV3 SW wait | Yes | Yes (`serviceWorker` fixture, 15s timeout) |
| `extensionId` from SW URL | Yes | Yes |
| Per-test profile isolation | `userDataDir: ""` (shared empty) | **`testInfo.outputPath('chromium-profile')`** (better for OPFS) |
| `headless` | `false` | Default (headed); Nix uses system `CHROMIUM_PATH` |
| SW console capture | No | Yes (`swLogs`, listener at context creation) |
| `openPopup` helper | Inline in spec / pages | Fixture `openPopup()` |
| Offscreen | N/A | **`waitForOffscreenDaemon`** — never `goto(offscreen.html)` |
| Upload RPC | N/A | E2E BC channel `gerolamino/offscreen-rpc-e2e` + `clientId=1` |

## Playwright upstream constraints (important)

From `extensions.spec.ts` / `extension-fixtures.ts`:

1. **`--load-extension` is not supported on Google Chrome channel builds** —
   use Chromium from Nix/`CHROMIUM_PATH`, not branded Chrome.
2. **MV3 service workers start lazily** — always `waitForEvent('serviceworker')`
   if `serviceWorkers()` is empty at fixture time.
3. **Headed mode** is sometimes required for extension singleton behavior;
   Playwright MCP extension tests set `headless: false` and
   `ignoreDefaultArgs: ['--enable-automation']`.
4. **Per-test `userDataDir`** is the reference pattern for parallel safety
   (`extension-fixtures.ts`); WXT’s empty string is fine for a toy counter
   but not for OPFS/LSM single-writer tests.

## Gerolamino-specific invariants (not in WXT examples)

```
popup (Port) → SW → BC gerolamino/offscreen-rpc → offscreen RpcServer → lsm-worker
E2E upload: popup → BC gerolamino/offscreen-rpc-e2e (clientId=1) — isolated from SW (clientId=0)
```

- Offscreen `OffscreenRpcs` server starts at **module load** (Ping/upload before
  bootstrap fork).
- E2E upload sets `gerolamino:e2e-defer-bootstrap` in `chrome.storage.session`
  so bootstrap does not contend with upload on the single lsm-worker.
- Storage watcher must **not** fork bootstrap while E2E defer is set — upload
  uses explicit `RequestRestart` after `saveSettings` (`offscreen/main.ts`).

## Recommended fixture tweaks (optional)

| Tweak | When |
|-------|------|
| `ignoreDefaultArgs: ['--enable-automation']` | If SW/offscreen fails only under automation flag |
| `headless: false` on CI | If Chromium extension singleton flakes |
| Clear `chrome.storage.local` at upload spec start | Serial upload project after integration seeds |

## Test project map

See `packages/chrome-ext/docs/e2e-playwright.md` for commands and worker
limits. Upload project stays `workers: 1` (lsm single-writer); fast project
can use full parallelism with isolated profiles.

## Gerolamino fixes derived from this audit (2026-05)

| Issue | Fix |
|-------|-----|
| SW boots offscreen before Playwright `storage.session` defer | Dev builds use `offscreen.html?deferBootstrapSync=1` in `offscreen-client.ts` |
| RpcServer blocked behind `lsmLayer` on `Layer.launch` | RpcServer launches without blocking; `lsmLayer` on handlers + parallel pre-warm fiber |
| First `UploadSnapshotChunk` hung 180s | Pre-warm `LsmRpcClient` at offscreen module load; SW Port relay path works in Playwright |
| `saveSettings` during upload forks bootstrap via watcher | Storage watcher skips fork when `readE2eDeferBootstrapFlag` is set |
| Popup direct BC RpcClient never received responses | Prefer **popup → SW Port → offscreen BC** for upload E2E (WXT sample uses page + extension, not popup BC client) |
| `chrome.storage.session` in `addInitScript` | Inline guarded `session.set` (no outer function references) |

## Apply checklist for new E2E specs

1. `bunx --bun wxt build --mode development` before Playwright.
2. Extend `./fixtures.ts` — do not use raw `page` without `context` fixture.
3. Open UI via `chrome-extension://${extensionId}/popup.html` (or `openPopup`).
4. Wait offscreen via `waitForOffscreenDaemon`, not navigation.
5. For upload: `installE2eDeferBootstrap` + `installE2eDirectOffscreenRpc` before SW boots.
6. Poll popup text / session logs, not SW-only signals for upload completion.
