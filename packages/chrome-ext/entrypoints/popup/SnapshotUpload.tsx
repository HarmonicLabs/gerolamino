/**
 * Snapshot upload — drag-and-drop a Mithril V2LSM snapshot directory
 * (or zipped tarball) into the popup; chunks stream to the offscreen
 * lsm-worker via SW relay.
 *
 * Wire format per chunk: `{ path, offset, bytes, final }`.
 *   - `path` is the OPFS-relative target (e.g. `lsm/active/0/data`).
 *   - `offset` lets the worker write into `FileSystemSyncAccessHandle`
 *     at the right position even when the chunk is mid-file.
 *   - `final` triggers `flush()` + `close()` of the OPFS handle.
 *
 * The component uses the File System Access API:
 *   - `showDirectoryPicker()` (Chromium 86+) for click-to-pick,
 *   - `DataTransferItem.getAsFileSystemHandle()` for drag-and-drop.
 *
 * After every file is written, the component calls
 * `ReopenAfterSnapshot` so the lsm-tree session sees the new tree.
 * The parent receives `BootstrapSettings { mode: "local" }` once the
 * upload completes (the SW reads `mode === "local"` and skips the WS
 * bootstrap path).
 */
import { Show, createSignal, onMount, type Component } from "solid-js";
import { Cause, Effect, Schedule } from "effect";
import * as Schema from "effect/Schema";
import {
  SnapshotReadError,
  validateSnapshotHandle,
  walkSnapshotDirectoryForBrowserUpload,
  type SnapshotFile,
} from "bootstrap";
import {
  DEFAULT_SETTINGS,
  loadSettingsFromChromeStorageWithRetry,
  saveSettings,
} from "../shared/bootstrap-settings.ts";
import { ChromeLocalKeyValueStoreLayer } from "../shared/chrome-key-value-store.ts";
import { requestEnsureOffscreen } from "../shared/ensure-offscreen-message.ts";
import { snapshotUploadError, snapshotUploadLog } from "../shared/snapshot-upload-log.ts";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { makeOffscreenUploadClient, waitForOffscreenUploadReady } from "./upload-rpc-client.ts";
import { uploadRpcLayer } from "./upload-rpc-layer.ts";

type ChunkPayload = {
  readonly path: string;
  readonly offset: number;
  readonly bytes: Uint8Array;
  readonly final: boolean;
};

const isSnapshotReadError = Schema.is(SnapshotReadError);

/** Stream-friendly chunk size. 1 MiB is large enough to amortise the
 *  three-hop RPC overhead per chunk, small enough to fit in the
 *  structured-clone limit (~64 MiB on Chromium ports). */
const CHUNK_SIZE = 1 << 20;

/** Type guard for `FileSystemDirectoryHandle`. Narrows the base
 *  `FileSystemHandle` union via the `kind` discriminant — works
 *  because `FileSystemDirectoryHandle.kind` is the literal
 *  `"directory"` per lib.dom typings. */
const isDirectoryHandle = (h: FileSystemHandle): h is FileSystemDirectoryHandle =>
  h.kind === "directory";

export interface SnapshotUploadProps {
  /** Called when the upload + reopen completes successfully. The
   *  parent (`SetupForm`) persists `mode: "local"` to settings so
   *  subsequent boots skip the WS bootstrap. */
  readonly onUploaded: () => void;
}

interface ExistingSnapshot {
  readonly byteCount: number;
  readonly lastModifiedMs: number;
}

const streamSnapshotFiles = <C extends {
  UploadSnapshotChunk: (input: ChunkPayload) => Effect.Effect<void, RpcClientError>;
}>(
  client: C,
  files: ReadonlyArray<SnapshotFile>,
  onProgress: (file: string, bytes: number) => void,
): Effect.Effect<void, RpcClientError> =>
  Effect.gen(function* () {
    let written = 0;
    let fileIx = 0;
    for (const { file, opfsPath } of files) {
      fileIx++;
      yield* snapshotUploadLog(
        `file ${fileIx}/${files.length}: ${opfsPath} (${(file.size / 1024).toFixed(1)} KiB)`,
      );
      onProgress(opfsPath, written);
      if (file.size === 0) {
        yield* client.UploadSnapshotChunk({
          path: opfsPath,
          offset: 0,
          bytes: new Uint8Array(0),
          final: true,
        });
        continue;
      }
      let offset = 0;
      while (offset < file.size) {
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const slice = file.slice(offset, end);
        const bytes = new Uint8Array(yield* Effect.promise(() => slice.arrayBuffer()));
        yield* client.UploadSnapshotChunk({
          path: opfsPath,
          offset,
          bytes,
          final: end === file.size,
        });
        offset = end;
        onProgress(opfsPath, written + offset);
      }
      written += file.size;
    }
  });

const reopenPersistAndRestart = (
  reopen: Effect.Effect<void, RpcClientError>,
  restart: Effect.Effect<void, RpcClientError>,
  onUploaded: () => void,
  onReopening: () => void,
  onDone: () => void,
): Effect.Effect<void, RpcClientError> =>
  Effect.gen(function* () {
    yield* snapshotUploadLog("all chunks uploaded; reopening lsm-tree session");
    onReopening();
    yield* reopen.pipe(Effect.retry(Schedule.recurs(3)));
    yield* snapshotUploadLog("reopen complete; persisting settings");
    yield* saveSettings({
      mode: "local",
      serverUrl: DEFAULT_SETTINGS.serverUrl,
    }).pipe(Effect.provide(ChromeLocalKeyValueStoreLayer), Effect.orDie);
    yield* loadSettingsFromChromeStorageWithRetry(10, 50);
    yield* Effect.sync(onUploaded);
    yield* snapshotUploadLog("restarting bootstrap-sync");
    yield* restart.pipe(Effect.retry(Schedule.recurs(3)));
    onDone();
  });

export const SnapshotUpload: Component<SnapshotUploadProps> = (props) => {
  const [status, setStatus] = createSignal<
    | { readonly kind: "idle" }
    | {
        readonly kind: "uploading";
        readonly file: string;
        readonly bytes: number;
        readonly total: number;
      }
    | { readonly kind: "reopening" }
    | { readonly kind: "done" }
    | { readonly kind: "error"; readonly message: string }
  >({ kind: "idle" });
  /** OPFS-detected previous upload — populated by the on-mount probe.
   *  When non-null the dropzone shows a "Use existing snapshot"
   *  shortcut that skips straight to the reopen step. */
  const [existing, setExisting] = createSignal<ExistingSnapshot | undefined>();
  /** Bumped when upload starts so the deferred OPFS probe cannot open a second Port. */
  let opfsProbeGeneration = 0;

  const setUploadProgress = (file: string, bytes: number, total: number) => {
    setStatus({ kind: "uploading", file, bytes, total });
  };

  // On mount, probe the offscreen → lsm-worker for an existing OPFS
  // snapshot. Cheap (one async OPFS walk) so it doesn't block the
  // popup render — Solid's `onMount` fires after first paint. If
  // the probe fails (e.g., offscreen not yet booted), silently
  // fall through to the upload path; the dropzone is still
  // available.
  // Defer OPFS probe so we do not open a second `chrome.runtime.connect` port
  // while the user is about to start a multi-hour upload (dual ports caused
  // `active=2` and hung the first `UploadSnapshotChunk` relay).
  onMount(() => {
    const generation = opfsProbeGeneration;
    const timer = globalThis.setTimeout(() => {
      if (status().kind !== "idle" || generation !== opfsProbeGeneration) return;
      Effect.runFork(
        Effect.gen(function* () {
          const client = yield* makeOffscreenUploadClient();
          const info = yield* client.InspectOpfsSnapshot();
          if (info.hasSession || info.hasSnapshots) {
            setExisting({ byteCount: info.byteCount, lastModifiedMs: info.lastModifiedMs });
          }
        }).pipe(Effect.scoped, Effect.provide(uploadRpcLayer()), Effect.catchCause(() => Effect.void)),
      );
    }, 8_000);
    return () => globalThis.clearTimeout(timer);
  });

  const offscreenUploadProgram = (
    files: ReadonlyArray<SnapshotFile>,
    total: number,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Effect.promise(() => requestEnsureOffscreen());
      yield* snapshotUploadLog("step 2.5: offscreen document ensured (SW)");
      yield* snapshotUploadLog("step 3: opening RpcClient (popup → offscreen BC)");
      const client = yield* makeOffscreenUploadClient();
      yield* snapshotUploadLog("step 2.5: waiting for offscreen relay (Ping)");
      yield* waitForOffscreenUploadReady(client);
      yield* snapshotUploadLog("step 2.5: relay ready");
      yield* snapshotUploadLog("step 3: RpcClient open; streaming chunks");
      yield* streamSnapshotFiles(client, files, (file, bytes) =>
        setUploadProgress(file, bytes, total),
      );
      yield* reopenPersistAndRestart(
        client.ReopenAfterSnapshot(),
        client
          .RequestRestart({
            settings: {
              mode: "local",
              serverUrl: DEFAULT_SETTINGS.serverUrl,
            },
          })
          .pipe(Effect.asVoid),
        () => props.onUploaded(),
        () => setStatus({ kind: "reopening" }),
        () => setStatus({ kind: "done" }),
      );
    });

  const runUpload = (handle: FileSystemDirectoryHandle) => {
    opfsProbeGeneration++;
    setStatus({ kind: "uploading", file: "(validating)", bytes: 0, total: 0 });
    Effect.runFork(
      Effect.gen(function* () {
        yield* snapshotUploadLog(`runUpload start; handle="${handle.name}"`);
        yield* snapshotUploadLog("step 1: validating layout");
        yield* Effect.promise(() => validateSnapshotHandle(handle));
        yield* snapshotUploadLog("step 1 done: layout OK");
        setStatus({ kind: "uploading", file: "(walking)", bytes: 0, total: 0 });
        yield* snapshotUploadLog("step 2: walking directory");
        const walked = yield* Effect.promise(() => walkSnapshotDirectoryForBrowserUpload(handle));
        const mib = walked.files.reduce((s, f) => s + f.file.size, 0) / 1024 / 1024;
        const skippedMib = walked.skippedImmutableBytes / 1024 / 1024;
        yield* snapshotUploadLog(
          `step 2 done: ${walked.files.length} files (${mib.toFixed(1)} MiB upload)` +
            (walked.skippedImmutableCount > 0
              ? `; skipped ${walked.skippedImmutableCount} immutable/ files (${skippedMib.toFixed(0)} MiB — relay will sync blocks)`
              : ""),
        );
        const total = walked.files.reduce((s, f) => s + f.file.size, 0);
        yield* offscreenUploadProgram(walked.files, total);
        yield* snapshotUploadLog("step 3 done: upload complete");
      }).pipe(
        Effect.scoped,
        Effect.provide(uploadRpcLayer()),
        Effect.orDie,
        Effect.tapCause((cause) =>
          Effect.gen(function* () {
            const squashed = Cause.squash(cause);
            const root = isSnapshotReadError(squashed) ? squashed.message : Cause.pretty(cause);
            yield* snapshotUploadError(`FAILED: ${root}`);
            yield* Effect.sync(() => setStatus({ kind: "error", message: root }));
          }),
        ),
      ),
    );
  };

  // File System Access API picker — Chrome 86+. The hidden `<input
  // type="file" webkitdirectory>` fallback is intentionally not
  // wired: Chromium-only is good enough for the initial cut, and
  // mixing the two paths complicates progress reporting.
  const pickViaPicker = () => {
    const picker = (
      globalThis as {
        readonly showDirectoryPicker?: (opts?: {
          mode?: "read";
        }) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;
    if (typeof picker !== "function") {
      setStatus({ kind: "error", message: "showDirectoryPicker unavailable in this browser" });
      return;
    }
    picker({ mode: "read" })
      .then(runUpload)
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });
  };

  /** Skip the upload entirely — call `ReopenAfterSnapshot` against
   *  the OPFS tree that's already there. Used by the "Use existing
   *  snapshot" affordance shown when `existing()` is non-null. */
  const resumeExisting = () => {
    setStatus({ kind: "reopening" });
    Effect.runFork(
      Effect.gen(function* () {
        yield* Effect.promise(() => requestEnsureOffscreen());
        const client = yield* makeOffscreenUploadClient();
        yield* waitForOffscreenUploadReady(client);
        yield* snapshotUploadLog("step 2.5: relay ready");
        yield* client.ReopenAfterSnapshot().pipe(Effect.retry(Schedule.recurs(3)));
        yield* saveSettings({
          mode: "local",
          serverUrl: DEFAULT_SETTINGS.serverUrl,
        }).pipe(Effect.provide(ChromeLocalKeyValueStoreLayer), Effect.orDie);
        yield* loadSettingsFromChromeStorageWithRetry(10, 50);
        props.onUploaded();
        yield* client
          .RequestRestart({
            settings: {
              mode: "local",
              serverUrl: DEFAULT_SETTINGS.serverUrl,
            },
          })
          .pipe(Effect.retry(Schedule.recurs(3)));
        setStatus({ kind: "done" });
      }).pipe(
        Effect.scoped,
        Effect.provide(uploadRpcLayer()),
        Effect.tapCause((cause) =>
          Effect.sync(() => setStatus({ kind: "error", message: String(cause) })),
        ),
      ),
    );
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const item = e.dataTransfer?.items[0];
    if (item === undefined || typeof item.getAsFileSystemHandle !== "function") {
      setStatus({
        kind: "error",
        message: "Drag-and-drop requires Chromium 86+ with File System Access API.",
      });
      return;
    }
    item.getAsFileSystemHandle().then((handle) => {
      if (handle === null || !isDirectoryHandle(handle)) {
        setStatus({ kind: "error", message: "Drop a directory, not a single file." });
        return;
      }
      runUpload(handle);
    });
  };

  // Detect whether we're running in the action's transient popup
  // (closes on focus loss) vs in a regular tab (focus-stable). The
  // directory picker requires the document to stay alive across the
  // OS file-chooser dialog — that's impossible in the popup, so we
  // gate-keep the upload flow behind "Continue in a tab" when we
  // detect popup-context. The detection key is the document height:
  // Chrome caps `chrome.action` popups at 600 px regardless of CSS,
  // while a popup.html loaded in a tab fills the viewport.
  const isInPopupContext = (): boolean =>
    typeof globalThis.window !== "undefined" &&
    globalThis.window.innerHeight <= 600 &&
    globalThis.window.location.search !== "?fullpage=1";

  const openInTab = () => {
    // Pre-select `mode=local` in the tab so the user doesn't have to
    // re-click the radio. SetupForm reads `?mode=` on mount.
    const url = globalThis.chrome.runtime.getURL("popup.html") + "?fullpage=1&mode=local";
    void globalThis.chrome.tabs.create({ url });
    // Close the popup so the user only has one window open. The
    // close call needs to happen on a microtask boundary so the tab
    // creation request lands before the popup tears down its JS.
    queueMicrotask(() => globalThis.window.close());
  };

  return (
    <div class="space-y-2">
      <Show when={isInPopupContext()}>
        <div class="space-y-1 border border-amber-400 bg-amber-100/10 rounded-md p-2 text-xs">
          <div class="font-medium text-amber-200">
            Chrome closes this popup when the directory picker opens
          </div>
          <div class="text-muted-foreground">
            Open the setup in a dedicated tab to upload a snapshot — the
            tab stays alive across the OS dialog, the popup doesn't.
          </div>
          <button
            type="button"
            onClick={openInTab}
            class="w-full mt-1 px-2 py-1 text-xs font-medium border border-amber-400 rounded-md bg-amber-400/20 hover:bg-amber-400/30"
            data-testid="open-in-tab"
          >
            Open setup in a dedicated tab →
          </button>
        </div>
      </Show>
      <Show when={existing() !== undefined && status().kind === "idle"}>
        {(_) => {
          const e = existing();
          if (e === undefined) return null;
          // `lastModifiedMs` is 0 when no files were under `/data/lsm/`
          // — surface a sensible relative-time string. For non-zero
          // mtimes, show "X mins ago" up to a day, then a date.
          const ageMins = e.lastModifiedMs > 0
            ? Math.floor((Date.now() - e.lastModifiedMs) / 60_000)
            : 0;
          const ageLabel = ageMins < 60
            ? `${ageMins} min ago`
            : ageMins < 60 * 24
              ? `${Math.floor(ageMins / 60)} h ago`
              : new Date(e.lastModifiedMs).toLocaleDateString();
          const mib = (e.byteCount / (1 << 20)).toFixed(1);
          return (
            <button
              type="button"
              onClick={resumeExisting}
              class="w-full text-left border border-border rounded-md p-2 hover:bg-muted/30"
              data-testid="resume-snapshot"
            >
              <div class="text-sm font-medium">Use existing snapshot ({mib} MiB, {ageLabel})</div>
              <div class="text-xs text-muted-foreground">
                Resume from the snapshot already in OPFS — no re-upload.
              </div>
            </button>
          );
        }}
      </Show>
      <div
        class="border-2 border-dashed border-border rounded-md p-4 text-center cursor-pointer hover:bg-muted/50"
        onClick={pickViaPicker}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        data-testid="snapshot-dropzone"
      >
        <div class="text-sm font-medium">
          {existing() !== undefined ? "Or drop a fresh snapshot" : "Drop a Mithril snapshot folder here"}
        </div>
        <div class="text-xs text-muted-foreground">or click to pick a directory</div>
      </div>
      <Show when={status().kind === "uploading"}>
        {(_) => {
          const s = status();
          if (s.kind !== "uploading") return null;
          const pct = s.total > 0 ? Math.floor((s.bytes / s.total) * 100) : 0;
          return (
            <div class="space-y-1">
              <div class="text-xs text-muted-foreground truncate" title={s.file}>
                {s.file}
              </div>
              <div class="h-1.5 w-full bg-muted rounded">
                <div
                  class="h-full bg-primary rounded transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div class="text-xs text-muted-foreground tabular-nums">
                {(s.bytes / (1 << 20)).toFixed(1)} / {(s.total / (1 << 20)).toFixed(1)} MiB
              </div>
            </div>
          );
        }}
      </Show>
      <Show when={status().kind === "reopening"}>
        <div class="text-xs text-muted-foreground">Reopening lsm-tree session…</div>
      </Show>
      <Show when={status().kind === "done"}>
        <div class="text-xs text-foreground">Snapshot loaded ✓</div>
      </Show>
      <Show when={status().kind === "error"}>
        {(_) => {
          const s = status();
          if (s.kind !== "error") return null;
          return <div class="text-xs text-destructive">Upload failed: {s.message}</div>;
        }}
      </Show>
    </div>
  );
};
