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
 *
 * Fail loudly if none resolve — silent fallback to a non-existent
 * binary surfaces as cryptic Playwright launch errors.
 */
import { test as base, chromium, type BrowserContext, type Worker, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Built extension directory. WXT outputs to `chrome-mv3-dev` for
 * `--mode development` and `chrome-mv3` for default (production)
 * builds; tests work against either.
 */
const candidatePaths = [
  path.join(import.meta.dirname, "../.output/chrome-mv3-dev"),
  path.join(import.meta.dirname, "../.output/chrome-mv3"),
];
const EXTENSION_PATH = candidatePaths.find((p) => existsSync(p)) ?? candidatePaths[0]!;

const resolveChromium = (): string => {
  const candidates = [
    process.env.CHROMIUM_PATH,
    process.env.BUN_CHROME_PATH,
    tryWhich("chromium"),
    tryWhich("chromium-browser"),
    tryNixShell(),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    "Chromium not found. Set CHROMIUM_PATH, install chromium on PATH, or run inside `nix develop`.",
  );
};

const tryWhich = (cmd: string): string | undefined => {
  try {
    return execSync(`which ${cmd}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
};

const tryNixShell = (): string | undefined => {
  try {
    return execSync("nix shell nixpkgs#chromium -c which chromium", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    }).trim();
  } catch {
    return undefined;
  }
};

const CHROMIUM_PATH = resolveChromium();

if (!existsSync(EXTENSION_PATH)) {
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
}>({
  // The context fixture seeds the swLogs buffer so the listener
  // attaches before the SW boots, eliminating the early-boot log race.
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      executablePath: CHROMIUM_PATH,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-sandbox",
        "--disable-gpu",
      ],
    });
    const logs: SwLog[] = [];
    (context as BrowserContext & { __swLogs?: SwLog[] }).__swLogs = logs;
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
    const logs = (context as BrowserContext & { __swLogs?: SwLog[] }).__swLogs;
    if (!logs) throw new Error("swLogs not initialised by context fixture");
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
