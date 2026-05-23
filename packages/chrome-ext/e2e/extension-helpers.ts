/**
 * Shared browser-side helpers for chrome-ext Playwright specs.
 *
 * These run inside `page.evaluate` / offscreen pages — keep them free of
 * Node/Bun imports so Playwright can serialize them cleanly.
 */
import type { BrowserContext, Page } from "@playwright/test";
import { Config, Console, Effect, FileSystem } from "effect";
import { pageEvaluate, pollUntil, sleep, waitForLoadState } from "./effect-helpers.ts";
import { RELAY_WS_URL } from "./relay-config.ts";
import {
  E2eFsLayer,
  formatSnapshotSeedSummary,
  listSnapshotFilesForE2eOpfsSeed,
  resolveE2eSnapshotPath,
} from "./snapshot-seed-fs.ts";

declare global {
  // eslint-disable-next-line no-var
  var __GEROLAMINO_E2E_LOG_COLLECTOR__: Array<string> | undefined;
}

/** Defer offscreen bootstrap until E2E seeds OPFS + settings (avoids empty-settings fork). */
export const installE2eDeferBootstrap = (context: BrowserContext): Effect.Effect<void> =>
  Effect.promise(() =>
    context.addInitScript(() => {
      const session = globalThis.chrome?.storage?.session;
      if (session !== undefined) {
        void session.set({ "gerolamino:e2e-defer-bootstrap": true }).catch(() => undefined);
      }
    }),
  );

/** Await session defer before SW creates the offscreen (init scripts are fire-and-forget). */
export const ensureE2eDeferBootstrap = (page: Page): Effect.Effect<void> =>
  Effect.promise(() =>
    page.evaluate(() => {
      const session = globalThis.chrome?.storage?.session;
      if (session === undefined) return Promise.resolve();
      return session.set({ "gerolamino:e2e-defer-bootstrap": true });
    }),
  ).pipe(Effect.asVoid);

/** Playwright often skips MV3 SW execution — popup Port RPC hangs without this. */
export const installE2eDirectOffscreenRpc = (context: BrowserContext): Effect.Effect<void> =>
  Effect.promise(() =>
    context.addInitScript(() => {
      globalThis.__GEROLAMINO_E2E_DIRECT_OFFSCREEN_RPC__ = true;
      globalThis.__GEROLAMINO_E2E_LOG_COLLECTOR__ = [];
      const channel = new BroadcastChannel("gerolamino/e2e-test-log");
      channel.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          globalThis.__GEROLAMINO_E2E_LOG_COLLECTOR__?.push(event.data);
        }
      });
    }),
  );

/** Clear the E2E bootstrap defer flag after OPFS + settings are seeded. */
export const clearE2eDeferBootstrap = (page: Page): Effect.Effect<void> =>
  Effect.promise(() =>
    page.evaluate(async () => {
      await globalThis.chrome.storage.session.remove("gerolamino:e2e-defer-bootstrap");
    }),
  ).pipe(Effect.asVoid);

/** Minimum Mithril V2LSM layout accepted by `validateSnapshotHandle`. */
export const MINIMAL_LEDGER_SLOT = "121230642";

/** Wipe the extension origin's OPFS root (hermetic runs). */
export const clearOpfsRoot = (page: Page): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* pageEvaluate(page, async () => {
      new BroadcastChannel("gerolamino/lsm-worker-control").postMessage("terminate");
    }).pipe(Effect.ignore);
    yield* pageEvaluate(page, async () => {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root.entries()) {
        await root.removeEntry(name, { recursive: true }).catch(() => undefined);
      }
    });
  }).pipe(Effect.asVoid);

/** Seed a tiny V2LSM tree for local-bootstrap / ingest tests. */
export const seedMinimalV2lsm = (page: Page): Effect.Effect<void> =>
  pageEvaluate(page, async () => {
    const root = await navigator.storage.getDirectory();
    const write = async (
      parent: FileSystemDirectoryHandle,
      name: string,
      data: BufferSource,
    ) => {
      const file = await parent.getFileHandle(name, { create: true });
      const w = await file.createWritable();
      await w.write(data);
      await w.close();
    };
    await write(root, "protocolMagicId", new TextEncoder().encode("1"));
    const ledger = await root.getDirectoryHandle("ledger", { create: true });
    const slot = await ledger.getDirectoryHandle("121230642", { create: true });
    await write(slot, "state", new Uint8Array([0x82, 0x01, 0x02]));
    const lsm = await root.getDirectoryHandle("lsm", { create: true });
    await lsm.getDirectoryHandle("active", { create: true });
    await write(lsm, "metadata", new TextEncoder().encode("v2"));
    await lsm.getDirectoryHandle("snapshots", { create: true });
  }).pipe(Effect.asVoid);

/** Ensure empty `lsm/snapshots/` exists (layout check; blobs not copied in E2E). */
const ensureOpfsSnapshotsDir = (page: Page): Effect.Effect<void> =>
  pageEvaluate(page, async () => {
    const root = await navigator.storage.getDirectory();
    const lsm = await root.getDirectoryHandle("lsm", { create: false });
    await lsm.getDirectoryHandle("snapshots", { create: true });
  }).pipe(Effect.asVoid);

/** Copy a host snapshot tree into extension OPFS (E2E-slim: no immutable / snapshot blobs). */
export const seedSnapshotFromDisk = (page: Page, snapshotPath: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { files, skippedImmutableCount, skippedSnapshotBlobCount } =
      yield* listSnapshotFilesForE2eOpfsSeed(snapshotPath);
    yield* Console.log(
      formatSnapshotSeedSummary(
        snapshotPath,
        files,
        skippedImmutableCount,
        skippedSnapshotBlobCount,
      ),
    );
    let written = 0;
    let writtenBytes = 0;
    for (const entry of files) {
      const bytes = yield* fs.readFile(entry.absolutePath);
      yield* Effect.promise(() =>
        page.evaluate(
          async (args: { opfsPath: string; data: number[] }) => {
            const root = await navigator.storage.getDirectory();
            const segments = args.opfsPath.split("/");
            const fileName = segments.at(-1);
            if (fileName === undefined || segments.length === 0) {
              throw new Error(`invalid opfs path: ${args.opfsPath}`);
            }
            let dir = root;
            for (const seg of segments.slice(0, -1)) {
              dir = await dir.getDirectoryHandle(seg, { create: true });
            }
            const file = await dir.getFileHandle(fileName, { create: true });
            const w = await file.createWritable();
            const payload = new Uint8Array(args.data);
            await w.write(payload);
            await w.close();
          },
          { opfsPath: entry.opfsPath, data: Array.from(bytes) },
        ),
      );
      written += 1;
      writtenBytes += entry.size;
      if (written % 5 === 0 || written === files.length) {
        const mib = (writtenBytes / 1024 / 1024).toFixed(1);
        yield* Console.log(`[e2e] OPFS seed ${written}/${files.length} (${mib} MiB)`);
      }
    }
    yield* ensureOpfsSnapshotsDir(page);
  }).pipe(Effect.provide(E2eFsLayer), Effect.orDie);

/**
 * Seed OPFS from `GEROLAMINO_SNAPSHOT_PATH` or `.devenv/state/db`.
 * Falls back to `seedMinimalV2lsm` when the path is missing or
 * `GEROLAMINO_USE_MINIMAL_SNAPSHOT=1`.
 */
/** Hermetic OPFS for upload E2E — includes `lsm/active/*` so `ReopenAfterSnapshot` passes. */
export const prepareUploadE2eOpfs = (page: Page): Effect.Effect<"full" | "minimal"> =>
  Effect.gen(function* () {
    yield* clearOpfsRoot(page);
    return yield* seedLocalSnapshotForE2e(page);
  }).pipe(Effect.provide(E2eFsLayer), Effect.orDie);

/** Mock `showDirectoryPicker` to re-upload the OPFS-root snapshot tree. */
export const installOpfsRootDirectoryPicker = (page: Page): Effect.Effect<void> =>
  Effect.promise(() =>
    page.addInitScript(() => {
      Object.defineProperty(globalThis, "showDirectoryPicker", {
        configurable: true,
        writable: true,
        value: async () => navigator.storage.getDirectory(),
      });
    }),
  );

export const seedLocalSnapshotForE2e = (page: Page): Effect.Effect<"full" | "minimal"> =>
  Effect.gen(function* () {
    const useMinimal = yield* Config.string("GEROLAMINO_USE_MINIMAL_SNAPSHOT").pipe(
      Config.withDefault(""),
      Effect.map((v) => v === "1"),
    );
    if (useMinimal) {
      yield* seedMinimalV2lsm(page);
      yield* Console.log("[e2e] GEROLAMINO_USE_MINIMAL_SNAPSHOT=1 — minimal fixture");
      return "minimal";
    }
    const snapshotPath = yield* resolveE2eSnapshotPath;
    if (snapshotPath === undefined) {
      yield* seedMinimalV2lsm(page);
      yield* Console.log(
        "[e2e] no snapshot on disk — minimal fixture (set GEROLAMINO_SNAPSHOT_PATH or populate .devenv/state/db)",
      );
      return "minimal";
    }
    yield* seedSnapshotFromDisk(page, snapshotPath);
    return "full";
  }).pipe(Effect.provide(E2eFsLayer), Effect.orDie);

export type BootstrapSettingsSeed = {
  readonly mode: "genesis" | "local";
  readonly serverUrl?: string;
};

const STORAGE_KEY = "gerolamino:bootstrap-settings"; // matches BOOTSTRAP_SETTINGS_STORAGE_KEY

/** Persist bootstrap mode for the offscreen pipeline on next boot/reload. */
export const seedBootstrapSettings = (
  page: Page,
  settings: BootstrapSettingsSeed,
): Effect.Effect<void> =>
  Effect.promise(() =>
    page.evaluate(
      (args: { key: string; settings: BootstrapSettingsSeed }) =>
        new Promise<void>((resolve, reject) => {
          const encoded = JSON.stringify(args.settings);
          globalThis.chrome.storage.local.set({ [args.key]: encoded }, () => {
            const err = globalThis.chrome.runtime?.lastError;
            if (err !== undefined) reject(new Error(err.message));
            else resolve();
          });
        }),
      { key: STORAGE_KEY, settings },
    ),
  ).pipe(Effect.asVoid);

/** Assert chrome.storage.local holds decodable bootstrap settings (probe-side). */
export const verifyBootstrapSettingsSeeded = (
  page: Page,
  settings: BootstrapSettingsSeed,
): Effect.Effect<void> =>
  Effect.promise(() =>
    page.evaluate(
      async (args: { key: string; expected: BootstrapSettingsSeed }) => {
        const bag = await globalThis.chrome.storage.local.get(args.key);
        const raw = bag[args.key];
        if (typeof raw !== "string") {
          throw new Error(`bootstrap settings missing or not a string (got ${typeof raw})`);
        }
        const parsed: unknown = JSON.parse(raw);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("mode" in parsed) ||
          !("serverUrl" in parsed)
        ) {
          throw new Error(`bootstrap settings not decodable: ${raw}`);
        }
        const mode = (parsed as { mode: string }).mode;
        const serverUrl = (parsed as { serverUrl: string }).serverUrl;
        if (mode !== args.expected.mode || serverUrl !== args.expected.serverUrl) {
          throw new Error(
            `bootstrap settings mismatch: expected ${JSON.stringify(args.expected)} got ${raw}`,
          );
        }
      },
      { key: STORAGE_KEY, expected: settings },
    ),
  ).pipe(Effect.asVoid);

/** True when offscreen bootstrap-sync has left the idle/deferred state. */
export const bootstrapSyncProgressLogged = (line: string): boolean =>
  /offscreen-sync.*WebSocket connected/i.test(line) ||
  /offscreen-sync.*Connecting to relay proxy/i.test(line) ||
  /offscreen-sync.*Initializing WASM/i.test(line) ||
  /offscreen-sync.*bootstrap-sync fiber started/i.test(line) ||
  /\[offscreen\].*Forking bootstrap-sync/i.test(line);

/** Force `chrome.storage.onChanged` on the offscreen watcher (remove + set). */
export const retriggerBootstrapSettings = (
  page: Page,
  settings: BootstrapSettingsSeed,
): Effect.Effect<void> =>
  Effect.promise(() =>
    page.evaluate(
      async (args: { key: string; settings: BootstrapSettingsSeed }) => {
        const encoded = JSON.stringify(args.settings);
        await globalThis.chrome.storage.local.remove(args.key);
        await globalThis.chrome.storage.local.set({ [args.key]: encoded });
      },
      { key: STORAGE_KEY, settings },
    ),
  ).pipe(Effect.asVoid);

export type OffscreenOpenOptions = {
  /** Skip eager bootstrap-sync so the lsm-worker pool is upload-exclusive. */
  readonly deferBootstrapSync?: boolean;
};

/**
 * Wait for the SW-managed offscreen document (via `ensureOffscreen`).
 *
 * Do **not** `page.goto(offscreen.html)` in Playwright — that opens a second
 * daemon in a normal tab while `chrome.offscreen.createDocument` already runs
 * one, duplicating BroadcastChannel RPC listeners and lsm-workers (3×
 * `writeChunk enter` / OPFS lock failures).
 */
export const waitForOffscreenDaemon = (
  page: Page,
  options?: OffscreenOpenOptions,
): Effect.Effect<void> =>
  Effect.promise(() =>
    page.evaluate(async (defer: boolean) => {
      if (defer) {
        const session = globalThis.chrome?.storage?.session;
        if (session !== undefined) {
          await session.set({ "gerolamino:e2e-defer-bootstrap": true });
        }
      }
      const deadline = Date.now() + 60_000;
      const getContexts = globalThis.chrome.runtime.getContexts;
      for (;;) {
        if (typeof getContexts === "function") {
          const contexts = await getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
          if (contexts.length > 0) return;
        } else {
          const session = globalThis.chrome?.storage?.session;
          if (session !== undefined) {
            const bag = await session.get(null);
            const merged: Array<string> = [];
            for (const [key, value] of Object.entries(bag)) {
              if (!key.startsWith("__gerolamino_logs__") || !Array.isArray(value)) continue;
              merged.push(...value);
            }
            if (
              merged.some((line: string) =>
                /\[offscreen\].*Offscreen daemon booting|\[offscreen\] main\.ts module loaded/i.test(
                  line,
                ),
              )
            ) {
              return;
            }
          }
        }
        if (Date.now() >= deadline) {
          throw new Error("SW offscreen document did not appear within 60s");
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }, options?.deferBootstrapSync === true),
  ).pipe(Effect.asVoid);

/** @deprecated Use `waitForOffscreenDaemon` — tab navigation duplicates the offscreen. */
export const gotoOffscreen = waitForOffscreenDaemon;

/** Read merged SW + offscreen + popup rings from session storage + BC collector. */
export const readSessionLogs = (page: Page): Effect.Effect<Array<string>> =>
  Effect.promise(() =>
    page.evaluate(async () => {
      const bag = await globalThis.chrome.storage.session.get(null);
      const merged: Array<string> = [];
      for (const [key, value] of Object.entries(bag)) {
        if (!key.startsWith("__gerolamino_logs__") || !Array.isArray(value)) continue;
        merged.push(...value);
      }
      const bc = globalThis.__GEROLAMINO_E2E_LOG_COLLECTOR__;
      if (Array.isArray(bc)) merged.push(...bc);
      return merged;
    }),
  );

/** Poll until the offscreen BC RpcServer is listening (Ping-safe before WASM worker init). */
export const waitForOffscreenRpcReady = (page: Page): Effect.Effect<void> =>
  pollUntil(
    Effect.gen(function* () {
      const logs = yield* readSessionLogs(page);
      return logs.some(
        (line) =>
          /\[offscreen\] main\.ts module loaded|OffscreenRpcs server listening/i.test(line) ||
          line.includes("__gerolamino_logs__:offscreen"),
      );
    }),
    { timeoutMs: 30_000, description: "offscreen RpcServer BC listener ready" },
  );

/** Poll until offscreen registered its watcher OR already forked bootstrap-sync. */
export const waitForOffscreenBootstrapReady = (page: Page): Effect.Effect<void> =>
  pollUntil(
    Effect.gen(function* () {
      const logs = yield* readSessionLogs(page);
      return logs.some(
        (line) =>
          /\[offscreen\].*bootstrap settings watcher registered/i.test(line) ||
          bootstrapSyncProgressLogged(line),
      );
    }),
    { timeoutMs: 60_000, description: "offscreen bootstrap watcher or fiber ready" },
  );

/**
 * After OPFS + settings are seeded: re-fire `chrome.storage.onChanged`, poll for
 * bootstrap-sync progress, then `RequestRestart` as fallback.
 */
export const kickBootstrapSyncAfterSeed = (
  context: BrowserContext,
  extensionId: string,
  probe: Page,
  settings: BootstrapSettingsSeed,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* verifyBootstrapSettingsSeeded(probe, settings);
    yield* retriggerBootstrapSettings(probe, settings);
    yield* verifyBootstrapSettingsSeeded(probe, settings);
    yield* triggerE2eBootstrapRestart(context, extensionId);
    yield* pollUntil(
      Effect.gen(function* () {
        const logs = yield* readSessionLogs(probe);
        return logs.some(bootstrapSyncProgressLogged);
      }),
      { timeoutMs: 120_000, description: "bootstrap-sync progress after RequestRestart" },
    );
  });

/** `?e2eRestart=1` → offscreen `RequestRestart` (preserves persisted settings). */
export const triggerE2eBootstrapRestart = (
  context: BrowserContext,
  extensionId: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const page = yield* Effect.promise(() => context.newPage());
    yield* Effect.promise(() =>
      page.addInitScript(() => {
        globalThis.__GEROLAMINO_E2E_DIRECT_OFFSCREEN_RPC__ = true;
      }),
    );
    yield* Effect.promise(() =>
      page.goto(`chrome-extension://${extensionId}/popup.html?fullpage=1&e2eRestart=1`),
    );
    yield* waitForLoadState(page);
    yield* sleep(3_000);
    yield* Effect.promise(() => page.close());
  });

/** Seed persisted settings then fork bootstrap-sync (`?e2eRestart=1` → RequestRestart). */
export const triggerBootstrapAfterSeed = (
  context: BrowserContext,
  extensionId: string,
  probe: Page,
  settings: BootstrapSettingsSeed,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* seedBootstrapSettings(probe, settings);
    yield* verifyBootstrapSettingsSeeded(probe, settings);
    yield* clearE2eDeferBootstrap(probe);
    yield* kickBootstrapSyncAfterSeed(context, extensionId, probe, settings);
  });

/** Genesis path — seed settings + `RequestRestart` (avoids SetupForm Port race). */
export const triggerGenesisStartSync = (
  context: BrowserContext,
  extensionId: string,
  probe: Page,
): Effect.Effect<void> =>
  triggerBootstrapAfterSeed(context, extensionId, probe, {
    mode: "genesis",
    serverUrl: RELAY_WS_URL,
  });

/** Local OPFS already seeded — persist `mode:local` + fork bootstrap-sync. */
export const triggerLocalBootstrapAfterSeed = (
  context: BrowserContext,
  extensionId: string,
  probe: Page,
): Effect.Effect<void> =>
  triggerBootstrapAfterSeed(context, extensionId, probe, {
    mode: "local",
    serverUrl: RELAY_WS_URL,
  });

/** Wait for OPFS probe + "Use existing snapshot" affordance (8s deferred inspect). */
export const waitForResumeSnapshotButton = (popup: Page): Effect.Effect<void> =>
  pollUntil(
    Effect.promise(() =>
      popup.locator('[data-testid="resume-snapshot"]').isVisible(),
    ),
    { timeoutMs: 30_000, description: "resume existing snapshot button" },
  );

/** Click resume — reopens OPFS tree without re-reading host files (avoids NotReadableError). */
export const clickResumeExistingSnapshot = (popup: Page): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* waitForResumeSnapshotButton(popup);
    yield* Effect.promise(() => popup.locator('[data-testid="resume-snapshot"]').click());
  });

/** Poll popup body text for upload/sync completion markers. */
export const pollUploadCompleteText = (
  page: Page,
): Effect.Effect<boolean> =>
  pageEvaluate(page, () => {
    const text = document.body.innerText;
    return /Snapshot loaded|Reopening lsm-tree session/.test(text);
  });
