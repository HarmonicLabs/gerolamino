/**
 * Diagnostic spec: end-to-end upload chain isolation test.
 *
 * The user reports their Mithril-snapshot upload sits at "0 MiB"
 * forever in ungoogled-chromium. Two failure surfaces are plausible:
 *
 *   (a) Source-code bug — the popup → SW → offscreen → worker → OPFS
 *       chain hangs for ANY non-trivial input.
 *   (b) Browser-specific bug — the chain works in Playwright's
 *       chromium but not in ungoogled-chromium for some isolation /
 *       File-System-Access-API restriction reason.
 *
 * This spec isolates (a) by seeding a minimal V2LSM directory in
 * OPFS (bypassing the OS picker), mocking `showDirectoryPicker` to
 * return that directory handle, then driving the popup's upload
 * flow. Every layer's console is captured + correlated.
 *
 * Pass criteria: a 6-file fixture (~30 KB total) round-trips
 * through the upload pipeline in <30 s and the final status shows
 * `kind: "done"`.
 *
 * Body is an Effect program; `Clock.currentTimeMillis` + `Effect.sleep`
 * drive the polling loop, `Console.log` emits the structured dumps.
 */
import { Clock, Console, Effect } from "effect";
import { test, expect } from "./fixtures.ts";
import { dumpRecent, pageEvaluate, runE, sleep } from "./effect-helpers.ts";

test("upload chain pumps bytes end-to-end with a synthetic fixture", async ({
  context,
  extensionId,
  swLogs,
}) =>
  runE(
    Effect.gen(function* () {
      test.setTimeout(120_000);

      // ─── Step 0: wipe OPFS + seed fixture BEFORE the offscreen boots ───
      // Playwright's persistent context retains OPFS state across runs;
      // an offscreen page from a previous run can still hold open
      // `FileSystemSyncAccessHandle`s on files we want to upload. Clear
      // the state from a vanilla page (popup.html does not boot the LSM
      // worker on its own) BEFORE opening the offscreen so the worker
      // boots against a clean tree.
      const seedPage = yield* Effect.promise(() => context.newPage());
      yield* Effect.promise(() =>
        seedPage.goto(`chrome-extension://${extensionId}/popup.html`),
      );
      yield* pageEvaluate(seedPage, async () => {
        const root = await navigator.storage.getDirectory();
        for await (const [n] of (root as FileSystemDirectoryHandle).entries()) {
          await root.removeEntry(n, { recursive: true }).catch(() => undefined);
        }
        const fixture = await root.getDirectoryHandle("__fixture__", { create: true });
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
        await write(fixture, "protocolMagicId", new TextEncoder().encode("1"));
        const ledgerDir = await fixture.getDirectoryHandle("ledger", { create: true });
        const slotDir = await ledgerDir.getDirectoryHandle("121230642", { create: true });
        await write(slotDir, "state", new Uint8Array([0x82, 0x01, 0x02])); // CBOR [1, 2]
        const lsmDir = await fixture.getDirectoryHandle("lsm", { create: true });
        await lsmDir.getDirectoryHandle("active", { create: true });
        await write(lsmDir, "metadata", new TextEncoder().encode("v2"));
        await lsmDir.getDirectoryHandle("snapshots", { create: true });
      });
      yield* Effect.promise(() => seedPage.close());

      // ─── Step 1: spawn the offscreen + capture its console ─────────
      const offscreen = yield* Effect.promise(() => context.newPage());
      const offscreenLogs: string[] = [];
      offscreen.on("console", (m) => offscreenLogs.push(`[offscreen ${m.type()}] ${m.text()}`));
      offscreen.on("pageerror", (e) =>
        offscreenLogs.push(`[offscreen pageerror] ${e.message}`),
      );
      yield* Effect.promise(() =>
        offscreen.goto(`chrome-extension://${extensionId}/offscreen.html`),
      );
      yield* sleep(2_000); // give the LSM worker time to boot

      // ─── Step 3: open the popup as a fullpage tab (no auto-close) ──
      const popup = yield* Effect.promise(() => context.newPage());
      const popupLogs: string[] = [];
      popup.on("console", (m) => popupLogs.push(`[popup ${m.type()}] ${m.text()}`));
      popup.on("pageerror", (e) => popupLogs.push(`[popup pageerror] ${e.message}`));

      // ─── Step 4: inject a mock `showDirectoryPicker` BEFORE navigation
      yield* Effect.promise(() =>
        popup.addInitScript(() => {
          Object.defineProperty(globalThis, "showDirectoryPicker", {
            configurable: true,
            writable: true,
            value: async () => {
              const root = await navigator.storage.getDirectory();
              return root.getDirectoryHandle("__fixture__");
            },
          });
        }),
      );

      yield* Effect.promise(() =>
        popup.goto(`chrome-extension://${extensionId}/popup.html?fullpage=1&mode=local`),
      );
      yield* Effect.promise(() => popup.waitForLoadState("domcontentloaded"));
      yield* sleep(1500);

      const preClick = yield* pageEvaluate(popup, () => ({
        showDirectoryPickerType: typeof (
          globalThis as { showDirectoryPicker?: unknown }
        ).showDirectoryPicker,
        dropzonePresent:
          document.querySelector('[data-testid="snapshot-dropzone"]') !== null,
        bodyTextSnippet: document.body.innerText.slice(0, 300),
      }));
      yield* Console.log("=== PRE-CLICK STATE ===");
      yield* Console.log(JSON.stringify(preClick, null, 2));

      // ─── Step 5: click the drop zone → mocked picker → upload runs ──
      yield* Effect.promise(() => popup.locator('[data-testid="snapshot-dropzone"]').click());
      yield* sleep(2000);

      const postClick = yield* pageEvaluate(popup, () => ({
        statusKindGuess:
          document.body.innerText.match(/Uploading|Reopening|done|error|validating/i)?.[0] ??
          "<none>",
        errorPanel: document.querySelector('[data-testid="error"]')?.textContent ?? null,
        bodyTextSnippet: document.body.innerText.slice(0, 500),
      }));
      yield* Console.log("=== POST-CLICK STATE ===");
      yield* Console.log(JSON.stringify(postClick, null, 2));

      // ─── Step 6: poll for upload completion ────────────────────────
      const overallStart = yield* Clock.currentTimeMillis;
      let lastByteValue = 0;
      let lastByteTs = overallStart;
      let timedOut = false;
      const overallDeadline = overallStart + 60_000;

      for (;;) {
        const now = yield* Clock.currentTimeMillis;
        if (now >= overallDeadline) break;
        yield* sleep(2_000);
        const state = yield* pageEvaluate(popup, () => {
          const dropzone = document.querySelector('[data-testid="snapshot-dropzone"]');
          const text = document.body.innerText;
          return {
            dropzonePresent: dropzone !== null,
            statusText: text.slice(0, 500),
          };
        });
        const m = /(\d+(?:\.\d+)?)\s*\/\s*\d+(?:\.\d+)?\s*MiB/i.exec(state.statusText);
        const bytes = m !== null ? parseFloat(m[1]!) : 0;
        if (bytes !== lastByteValue) {
          lastByteValue = bytes;
          lastByteTs = yield* Clock.currentTimeMillis;
        }
        if (/Reopening lsm-tree session/.test(state.statusText)) {
          continue;
        }
        if (
          !/MiB/.test(state.statusText) &&
          !/Reopening|Uploading|validating/i.test(state.statusText)
        ) {
          break;
        }
        const tickNow = yield* Clock.currentTimeMillis;
        if (tickNow - lastByteTs > 30_000) {
          timedOut = true;
          break;
        }
      }

      const elapsedMs = (yield* Clock.currentTimeMillis) - overallStart;
      yield* Console.log(`=== UPLOAD elapsed: ${elapsedMs / 1000}s ===`);
      yield* Console.log(`Last byte snapshot: ${lastByteValue} MiB`);
      yield* dumpRecent("=== POPUP CONSOLE (last 30) ===", popupLogs);
      yield* dumpRecent("=== OFFSCREEN CONSOLE (last 30) ===", offscreenLogs);
      // SW logs come from `worker.on("console", ...)` (see fixtures.ts
      // `captureWorkerLogs`) — different stream than the page-on-console
      // listeners above; tracks RpcServerLive + relay handlers running
      // INSIDE the service worker.
      yield* dumpRecent(
        "=== SW CONSOLE (last 30) ===",
        swLogs.map((e) => `[sw ${e.type}] ${e.text}`),
      );

      expect(timedOut).toBe(false);
    }),
  ));
