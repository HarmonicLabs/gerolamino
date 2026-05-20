/**
 * Playwright test fixtures for the Gerolamino Chrome extension.
 *
 * Mirrors the canonical pattern from `~/code/reference/playwright/tests/library/chromium/extensions.spec.ts`
 * and `tests/extension/extension-fixtures.ts` — extensions require a
 * `chromium.launchPersistentContext` (no extension support in ephemeral
 * contexts) plus `--load-extension`/`--disable-extensions-except` flags.
 *
 * Provides:
 *   - `context`: the persistent BrowserContext with the extension loaded
 *   - `serviceWorker`: the MV3 background SW handle
 *   - `extensionId`: the dynamically-assigned chrome-extension://<id>
 *   - `swLogs`: a live array of SW console messages — tests can poll for
 *     specific log lines instead of racing the SW boot sequence
 *   - `openPopup`: helper that opens `popup.html` in a fresh page
 *
 * The extension build target is `.output/chrome-mv3-dev` (produced by
 * `bunx --bun wxt build --mode development`). Run the build before the
 * tests via `package.json#scripts.e2e` or manually.
 *
 * NixOS chromium resolution: Playwright's bundled Chromium needs shared
 * libs that nixpkgs doesn't provide. We resolve a system chromium via:
 *
 *   1. `CHROMIUM_PATH` env (explicit override)
 *   2. `BUN_CHROME_PATH` env (re-uses the flake's existing wiring for
 *      Bun.WebView in apps/tui)
 *   3. `which chromium` / `chromium-browser`
 *   4. `nix shell nixpkgs#chromium -c which chromium`
 *   5. `nix shell nixpkgs#ungoogled-chromium -c which chromium`
 *
 * Fail loudly if none resolve — silent fallback to a non-existent
 * binary surfaces as cryptic Playwright launch errors.
 *
 * Module-load uses Bun-native APIs (`Bun.spawnSync`, `Bun.file().size`)
 * instead of `node:child_process` / `node:fs` so the test rig stays
 * `node:*`-free. Effect's FileSystem/Path services aren't usable here
 * because Playwright loads this file synchronously during test discovery,
 * before any Effect runtime exists.
 */
import {
  test as base,
  chromium,
  type BrowserContext,
  type Worker,
  type Page,
} from "@playwright/test";
import { invariant, isNotNil } from "es-toolkit";

/** Sync existence check that doesn't import `node:fs`. */
const fileExistsSync = (p: string): boolean => Bun.file(p).size > 0;
const dirExistsSync = (p: string): boolean => {
  // `Bun.file().size` returns 0 for directories on POSIX; probe with a
  // known dir-marker file instead. We canonicalise `p` by appending the
  // OS-agnostic separator and a sentinel — `manifest.json` is always
  // present at the WXT-built extension root.
  return Bun.file(`${p}/manifest.json`).size > 0;
};

/** Sync command-runner that doesn't import `node:child_process`. */
const tryExecSync = (cmd: ReadonlyArray<string>, timeoutMs?: number): string | undefined => {
  const result = Bun.spawnSync({
    cmd: [...cmd],
    stdout: "pipe",
    stderr: "ignore",
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
  });
  if (result.exitCode !== 0) return undefined;
  const out = result.stdout.toString().trim();
  return out.length > 0 ? out : undefined;
};

/**
 * Built extension directory. WXT outputs to `chrome-mv3-dev` for
 * `--mode development` and `chrome-mv3` for default (production)
 * builds; tests work against either.
 */
const candidatePaths = [
  `${import.meta.dirname}/../.output/chrome-mv3-dev`,
  `${import.meta.dirname}/../.output/chrome-mv3`,
];
const EXTENSION_PATH = candidatePaths.find(dirExistsSync) ?? candidatePaths[0]!;

const resolveChromium = (): string => {
  const candidates = [
    process.env["CHROMIUM_PATH"],
    process.env["BUN_CHROME_PATH"],
    tryExecSync(["which", "chromium"]),
    tryExecSync(["which", "chromium-browser"]),
    tryExecSync(["nix", "shell", "nixpkgs#chromium", "-c", "which", "chromium"], 15_000),
    tryExecSync(["nix", "shell", "nixpkgs#ungoogled-chromium", "-c", "which", "chromium"], 15_000),
  ]
    .filter(isNotNil)
    .filter((p) => p.length > 0);
  const resolved = candidates.find(fileExistsSync);
  invariant(
    resolved !== undefined,
    "Chromium not found. Set CHROMIUM_PATH, install chromium on PATH, or run inside `nix develop`.",
  );
  return resolved;
};

const CHROMIUM_PATH = resolveChromium();

if (!dirExistsSync(EXTENSION_PATH)) {
  throw new Error(
    `Extension build missing at ${EXTENSION_PATH}. Run \`bunx --bun wxt build --mode development\` first.`,
  );
}

/**
 * Capture SW console output. Tests can poll the array (or use the
 * `expect.poll` helper) to wait on specific log lines without racing
 * the SW boot sequence.
 */
type SwLog = { type: string; text: string; ts: number };

/** Per-context SW-log buffer, attached via WeakMap to avoid `as` casts. */
const swLogsByContext = new WeakMap<BrowserContext, SwLog[]>();

/**
 * Shared per-context SW-log buffer. Attaching the listener at context
 * creation time (before the SW boots) means we capture every console
 * message — there's no window during which boot logs are emitted but
 * not yet observed by a `serviceWorker.on("console", …)` handler.
 */
const captureWorkerLogs = (context: BrowserContext, logs: SwLog[]) => {
  const attach = (worker: Worker) => {
    worker.on("console", (msg) => {
      logs.push({ type: msg.type(), text: msg.text(), ts: Date.now() });
    });
  };
  for (const w of context.serviceWorkers()) attach(w);
  context.on("serviceworker", attach);
};

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  swLogs: SwLog[];
  openPopup: () => Promise<Page>;
  /** Set by `e2e/global-setup.ts` — true when `localhost:3040` relay responds. */
  relayAvailable: boolean;
}>({
  // eslint-disable-next-line no-empty-pattern
  relayAvailable: async ({}, use) => {
    await use(process.env.GEROLAMINO_RELAY_E2E === "1");
  },

  // Per-test profile dir (Playwright `testInfo.outputPath`) — parallel-safe.
  // Reference: `tests/extension/extension-fixtures.ts` uses
  // `testInfo.outputPath('extension-user-data-dir')` instead of `""`.
  context: async ({}, use, testInfo) => {
    const userDataDir = testInfo.outputPath("chromium-profile");
    const context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: CHROMIUM_PATH,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-sandbox",
        "--disable-gpu",
      ],
    });
    const logs: SwLog[] = [];
    swLogsByContext.set(context, logs);
    captureWorkerLogs(context, logs);
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    const id = serviceWorker.url().split("/")[2];
    await use(id);
  },

  swLogs: async ({ context }, use) => {
    const logs = swLogsByContext.get(context);
    invariant(logs !== undefined, "swLogs not initialised by context fixture");
    await use(logs);
  },

  openPopup: async ({ context, extensionId }, use) => {
    await use(async () => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`);
      return page;
    });
  },
});

export const expect = test.expect;
