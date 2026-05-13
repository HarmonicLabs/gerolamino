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
import { Effect, Schedule } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import {
  SnapshotReadError,
  validateSnapshotHandle,
  walkSnapshotDirectory,
  type SnapshotFile,
} from "bootstrap";
import { NodeRpcs } from "../background/rpc.ts";
import { layerClientProtocolChromePort } from "../background/rpc-transport.ts";

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

  // On mount, probe the offscreen → lsm-worker for an existing OPFS
  // snapshot. Cheap (one async OPFS walk) so it doesn't block the
  // popup render — Solid's `onMount` fires after first paint. If
  // the probe fails (e.g., offscreen not yet booted), silently
  // fall through to the upload path; the dropzone is still
  // available.
  onMount(() => {
    Effect.runFork(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(NodeRpcs);
        const info = yield* client.InspectOpfsSnapshot();
        if (info.hasSession || info.hasSnapshots) {
          setExisting({ byteCount: info.byteCount, lastModifiedMs: info.lastModifiedMs });
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(RpcSerialization.layerMsgPack),
        Effect.provide(layerClientProtocolChromePort),
        Effect.catchCause(() => Effect.void),
      ),
    );
  });

  /** Drive an entire snapshot upload to completion. Composed inside a
   *  single Effect so the RpcClient + Port lifetime is one scope —
   *  every chunk reuses the same MessagePort, and the scope cleans
   *  up the port automatically when this effect resolves or fails. */
  const uploadProgram = (files: ReadonlyArray<SnapshotFile>, total: number) =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(NodeRpcs);
      let written = 0;
      for (const { file, opfsPath } of files) {
        setStatus({ kind: "uploading", file: opfsPath, bytes: written, total });
        if (file.size === 0) {
          // Zero-byte create + close so the OPFS tree still sees the
          // file. The worker handles `bytes.length === 0 && final` by
          // opening the handle without writing.
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
          setStatus({ kind: "uploading", file: opfsPath, bytes: written + offset, total });
        }
        written += file.size;
      }
      setStatus({ kind: "reopening" });
      // Worker may briefly still be flushing the last OPFS handles when
      // the popup sends Reopen; bounded-retry absorbs that race. `recurs`
      // is a count-only schedule in v4; the 250 ms granularity is
      // implicit in the cross-process RPC round-trip latency.
      yield* client.ReopenAfterSnapshot().pipe(Effect.retry(Schedule.recurs(3)));
      // Restart the offscreen bootstrap-sync fiber so it re-reads
      // the newly-populated OPFS `ledger/<slot>/state` and seeds
      // `LedgerView` + `Nonces` + tip. `StartSync` relays to the
      // offscreen's `RequestRestart` handler.
      yield* client.StartSync().pipe(Effect.retry(Schedule.recurs(3)));
      setStatus({ kind: "done" });
    }).pipe(
      Effect.scoped,
      Effect.provide(RpcSerialization.layerMsgPack),
      Effect.provide(layerClientProtocolChromePort),
    );

  const runUpload = (handle: FileSystemDirectoryHandle) => {
    setStatus({ kind: "uploading", file: "(validating)", bytes: 0, total: 0 });
    // Pre-flight validation: confirm the dropped directory matches the
    // Mithril V2LSM layout BEFORE wasting MiBs streaming to OPFS. The
    // `bootstrap` package owns the layout constants; both this popup
    // and apps/tui's `--snapshot-path` reader share them.
    Effect.runFork(
      Effect.promise(() => validateSnapshotHandle(handle)).pipe(
        Effect.flatMap(() => Effect.promise(() => walkSnapshotDirectory(handle))),
        Effect.flatMap((files) => {
          const total = files.reduce((s, f) => s + f.file.size, 0);
          return uploadProgram(files, total);
        }),
        Effect.tap(() => Effect.sync(() => props.onUploaded())),
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            // `SnapshotReadError` carries a structured message; fall
            // back to `String(cause)` for unknown failures.
            const root = cause instanceof SnapshotReadError ? cause.message : String(cause);
            setStatus({ kind: "error", message: root });
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
        const client = yield* RpcClient.make(NodeRpcs);
        yield* client.ReopenAfterSnapshot().pipe(Effect.retry(Schedule.recurs(3)));
        // Re-read OPFS on the offscreen side so consensus reseeds
        // `LedgerView` from the existing snapshot.
        yield* client.StartSync().pipe(Effect.retry(Schedule.recurs(3)));
        setStatus({ kind: "done" });
        props.onUploaded();
      }).pipe(
        Effect.scoped,
        Effect.provide(RpcSerialization.layerMsgPack),
        Effect.provide(layerClientProtocolChromePort),
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
    const url = globalThis.chrome.runtime.getURL("popup.html") + "?fullpage=1";
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
