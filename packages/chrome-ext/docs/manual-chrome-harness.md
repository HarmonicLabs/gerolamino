# Manual Chromium QA harness (Gerolamino chrome-ext)

Step-by-step verification in a **real** Chromium profile (not Playwright). Use this
after `wxt build --mode development` and with the relay proxy running when you
want live sync-to-tip.

## Prerequisites

```sh
# Repo root — relay WS→TCP proxy (preprod upstream)
devenv tasks run relay:websockify

# Extension build
cd packages/chrome-ext
bunx --bun wxt build --mode development
```

Optional: a real preprod Mithril **V2LSM** snapshot directory on disk (same layout
as `packages/bootstrap` `validateSnapshotHandle` — `protocolMagicId`,
`ledger/<slot>/state`, `lsm/{active,metadata,snapshots}`).

**Upload scope:** the extension uploads `protocolMagicId`, `ledger/`, and `lsm/`
only — it **skips `immutable/`** (~10k+ chunk files, often 10+ GiB). That matches
cardano-node fast-bootstrap intent: ledger state + LSM session locally, blocks
after the snapshot tip via relay ChainSync. Popup console logs  
`skipped N immutable/ files` after step 2.

**Before a fresh upload:** clear prior OPFS data (extension reset or DevTools →
Application → OPFS → delete origin) so stale sync handles cannot deadlock the
first chunk.

## 1. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select  
   `packages/chrome-ext/.output/chrome-mv3-dev`
4. Note the extension ID (needed for offscreen DevTools URLs)

## 2. Relay sanity

With `devenv tasks run relay:websockify` running:

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3040/
```

Any response with status &lt; 500 means the listener is up (404/426 is fine).

## 3. First-open setup (local snapshot path)

1. Click the extension icon → popup opens.
2. If you see **“Chrome closes this popup when the directory picker opens”**,
   click **Open setup in a dedicated tab** (or open  
   `chrome-extension://<id>/popup.html?fullpage=1&mode=local` manually).
3. Select **From a local Mithril snapshot**.
4. Click the drop zone → pick your snapshot **root directory** in the OS dialog.
5. Wait for upload progress, then **“Reopening lsm-tree session…”**, then
   **“Snapshot loaded ✓”**.
6. Click **Start syncing** (persists settings and opens the dashboard).

### Expected popup console lines

Effect logger output is prefixed `[snapshot-upload]` (see DevTools console):

```
[snapshot-upload] step 1 done: layout OK
[snapshot-upload] step 2 done: N files (… MiB upload); skipped … immutable/ …
[snapshot-upload] step 2.5: offscreen document ensured (SW)
[snapshot-upload] step 2.5: waiting for offscreen relay (Ping)
[snapshot-upload] step 2.5: relay ready
[snapshot-upload] step 3: opening RpcClient (popup → offscreen BC)
[snapshot-upload] step 3: RpcClient open; streaming chunks
[snapshot-upload] file 1/N: protocolMagicId …
[snapshot-upload] reopen complete; persisting settings
[snapshot-upload] restarting bootstrap-sync
```

Snapshot upload is **popup → BroadcastChannel (`clientId=2`) → offscreen**
(not Port → SW — MV3 SW sleep disconnects long uploads). Dashboard deltas
still use **popup → Port → SW → offscreen**.

## 4. Offscreen + lsm-worker logs

Open the offscreen document (Chrome 124+):

- `chrome://extensions` → Gerolamino → **Inspect views: offscreen.html**  
  or navigate to `chrome-extension://<id>/offscreen.html`

### Upload phase (before / during first sync)

```
[offscreen-handler] UploadSnapshotChunk path=… offset=… bytes=… final=…
[offscreen-handler] UploadSnapshotChunk DONE path=…
[offscreen-handler] ReopenAfterSnapshot
[lsm-worker] +…ms writeChunk enter path=…
```

You should see **one** `writeChunk enter` per chunk (not 2–3 duplicates).

### Bootstrap-sync phase (after StartSync / upload restart)

```
[offscreen-sync] Settings: mode=local, relayUrl=ws://127.0.0.1:3040 …
[offscreen-ingest] … OPFS ledger-state …   # success with real snapshot CBOR
[offscreen-sync] WebSocket connected
[offscreen-sync] Starting Ouroboros miniprotocol sync … seeded=snapshot|genesis
[offscreen-sync] First tip observed: slot N
```

With a **minimal / dummy** ledger `state` file, ingest may log a graceful fallback
to genesis — that is expected for synthetic fixtures only.

### Service worker (optional)

`chrome://extensions` → **service worker** link for Gerolamino:

```
[gerolamino] Background service worker started
[offscreen-client] Offscreen document ready
[gerolamino] Launching RPC server …
```

## 5. Dashboard checks

After setup completes, the popup shows **BrowserDashboard**:

| Panel | What to look for |
|-------|------------------|
| Node status | `syncing` → `caught-up` (or `error` with relay down) |
| Tip / epoch | Slot and epoch numbers updating over ~30 s |
| Peers | At least `relay-proxy:3001` |
| Chain events | Rows appearing as blocks are processed |
| Mempool | May stay empty on preprod relay proxy |

**Reset bootstrap mode** (`data-testid="reset-settings"`) returns to the setup
form.

## 6. Settings saved before offscreen reads them

If you configure bootstrap mode while the offscreen document is already running
(first install race), bootstrap-sync starts when `chrome.storage.local` receives
`gerolamino:bootstrap-settings` (watcher in `offscreen/main.ts`). You do not need
to reload the extension — `Start Sync` / upload completion also calls `StartSync`.

## 7. Genesis-only path (no snapshot)

1. Setup form → **From genesis (slow, no snapshot)** → **Start syncing**.
2. Offscreen should log `mode=genesis` and `WebSocket connected` without any
   upload handler lines.

## 7. Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Upload stuck at 0 MiB, no `[offscreen-handler] UploadSnapshotChunk` | SW not running, or bootstrap-sync still holding lsm-worker (first open should defer until settings exist) |
| `relayUpload: timeout after 180s` on first file | Upload started before offscreen RpcServer registered (BC does not replay). Reload extension, wait ~5 s after SW boot, retry; popup step 2.5 should log `relay ready` first |
| `Upload failed: TimeoutError` at step 2.5 | Offscreen BC server not up yet, or (older builds) relay probe used `InspectOpfs` and walked a huge OPFS `lsm/` tree. Rebuild; expect **Ping** probe + `relay ready` within a few seconds |
| Ping / upload timeout at step 2.5 (120s) with BC upload | Fixed: wire BC `clientId` (2) must map to Effect `RpcClient` id (0) on delivery — see `rpcClientIdsForWireResponse` |
| `RpcClient.make` hangs with E2E direct BC flag | SW + popup must use distinct wire `clientId`s (0 vs 2); never share wire id 0 from popup |
| Triple `writeChunk enter` per chunk | Multiple lsm-worker listeners — check `lsm-worker-protocol.ts` singleton |
| `LedgerSnapshotError` in offscreen during upload test | bootstrap-sync started before upload finished — use `?deferBootstrapSync=1` in E2E only |
| Dashboard stays “Loading” | Port/delta relay; confirm SW + offscreen running |

## 8. Inspecting OPFS (lsm-tree writes)

Chrome does **not** expose extension OPFS as a normal on-disk folder you can open in
Nautilus. All snapshot bytes go through the **Origin Private File System** API inside
the extension origin (`chrome-extension://<id>/`).

### Where writes happen

| Layer | API | Paths |
|-------|-----|--------|
| Popup upload | `FileSystemSyncAccessHandle` in **lsm-worker** | OPFS root: `protocolMagicId`, `ledger/<slot>/state`, `lsm/...` |
| lsm-tree session (after Reopen) | WASI shim over same OPFS | Worker preopen `/data/lsm/` |

### DevTools steps

1. `chrome://extensions` → Gerolamino → **Inspect views: offscreen.html**
2. **Console** — filter `[lsm-worker]` for per-chunk logs:
   - `writeChunk enter path=protocolMagicId …`
   - `writeChunk enter path=ledger/…/state …`
   - `writeChunk enter path=lsm/…`
3. **Application** tab → **Storage** → **Origin Private File System** (under the
   extension origin). You should see directories `ledger/`, `lsm/`, and file
   `protocolMagicId` grow during upload.
4. **Application** → **Session storage** → `__gerolamino_logs__` — mirrored Effect
   logs from SW/offscreen (useful when the service worker console is empty).

### Storage quota

In the offscreen console:

```javascript
const est = await navigator.storage.estimate();
console.log("usage MiB", est.usage / (1 << 20), "quota MiB", est.quota / (1 << 20));
```

A preprod Mithril tree is ~1–2 GiB upload tier (without `immutable/`); ensure quota
is not exhausted from prior attempts — use **Reset bootstrap mode** or clear site
data for the extension origin if uploads fail mysteriously.

## 9. Playwright parity

```sh
cd packages/chrome-ext
bunx --bun wxt build --mode development
bunx --bun playwright test --project=fast
bunx --bun playwright test --project=upload
bunx --bun playwright test --project=integration   # relay optional for mithril-to-tip
```

See [e2e-playwright.md](./e2e-playwright.md) for env vars (`GEROLAMINO_RELAY_E2E`,
`MITHRIL_FIXTURE_PATH`).

## Production vs E2E-only behavior

| Mechanism | Production | E2E / Playwright only |
|-----------|------------|------------------------|
| Upload RPC transport | `NodeRpcs` + Port → SW → offscreen BC | `__GEROLAMINO_E2E_DIRECT_OFFSCREEN_RPC__` (avoid — collides with SW) |
| Defer bootstrap-sync | Automatic when **no** persisted settings | `offscreen.html?deferBootstrapSync=1` |
| `showDirectoryPicker` mock | User picks real directory | `addInitScript` synthetic `FileSystemDirectoryHandle` |
| OPFS seed | User upload | `seedMinimalV2lsm` in integration specs |
