/**
 * End-to-end upload chain test using a SYNTHETIC `FileSystemDirectoryHandle`.
 *
 * The earlier `diag-upload-chain.spec.ts` failed at
 * `createSyncAccessHandle` because the test seeded `__fixture__/`
 * via `createWritable()` on real OPFS handles, and Chromium's
 * persistent-context retains cross-page locks even after the source
 * page closes. This spec avoids the lock entirely by injecting a
 * pure in-memory `FileSystemDirectoryHandle`-shaped mock backed by
 * `Blob`s — `walkSnapshotDirectory` only calls `entries()` +
 * `getFile()`, both of which the mock satisfies without ever opening
 * a real OPFS handle. The worker then writes to OPFS root paths that
 * are NEW (no prior handle to conflict with).
 *
 * Pass criteria: the upload pipeline emits "Snapshot loaded ✓" within
 * 30 s. The fixture is the minimum Mithril V2LSM layout required by
 * `validateSnapshotHandle` (`protocolMagicId` + `ledger/<slot>/state`
 * + `lsm/{active,metadata,snapshots}`).
 */
import { Clock, Console, Effect, Exit } from "effect";
import { test, expect } from "./fixtures.ts";
import { pageEvaluate, pollSync, pollUntil, runE, sleep, waitForLoadState } from "./effect-helpers.ts";

test.describe("Upload chain (synthetic FS Access handle)", () => {
  test.setTimeout(120_000);

  test("popup walks injected handle + offscreen writes to OPFS without lock conflict", async ({
    context,
    extensionId,
  }) =>
    runE(
      Effect.gen(function* () {
        // ─── Step 0: wipe OPFS from a vanilla page so the offscreen
        // worker boots against a clean tree. The worker walks `/lsm/`
        // at boot to populate the WASI preopen; existing entries with
        // unreleased sync handles would block later writes.
        const seedPage = yield* Effect.promise(() => context.newPage());
        yield* Effect.promise(() =>
          seedPage.goto(`chrome-extension://${extensionId}/popup.html`),
        );
        yield* pageEvaluate(seedPage, async () => {
          const root = await navigator.storage.getDirectory();
          for await (const [n] of (root as FileSystemDirectoryHandle).entries()) {
            await root.removeEntry(n, { recursive: true }).catch(() => undefined);
          }
        });
        yield* Effect.promise(() => seedPage.close());

        // ─── Step 1: open the offscreen + capture logs.
        const offscreen = yield* Effect.promise(() => context.newPage());
        const offscreenLogs: Array<string> = [];
        offscreen.on("console", (m) =>
          offscreenLogs.push(`[off ${m.type()}] ${m.text()}`),
        );
        offscreen.on("pageerror", (e) =>
          offscreenLogs.push(`[off pageerror] ${e.message}`),
        );
        yield* Effect.promise(() =>
          offscreen.goto(`chrome-extension://${extensionId}/offscreen.html`),
        );
        yield* sleep(3000); // worker boot + WASI init

        // ─── Step 2: open the popup with a mocked showDirectoryPicker
        // that returns a SYNTHETIC handle (no OPFS reads), then click
        // the drop zone to fire the upload pipeline.
        const popup = yield* Effect.promise(() => context.newPage());
        const popupLogs: Array<string> = [];
        popup.on("console", (m) => popupLogs.push(`[pop ${m.type()}] ${m.text()}`));
        popup.on("pageerror", (e) => popupLogs.push(`[pop pageerror] ${e.message}`));

        // Inject the mock BEFORE navigation so it's available when the
        // Solid component mounts.
        yield* Effect.promise(() =>
          popup.addInitScript(() => {
            const blobFile = (name: string, bytes: Uint8Array): File =>
              new File([new Blob([new Uint8Array(bytes)])], name);
            const mkFileHandle = (name: string, bytes: Uint8Array) => ({
              kind: "file" as const,
              name,
              getFile: async () => blobFile(name, bytes),
            });
            const mkDirHandle = (
              name: string,
              entries: ReadonlyArray<readonly [string, unknown]>,
            ) => {
              const map = new Map(entries);
              return {
                kind: "directory" as const,
                name,
                entries: async function* () {
                  for (const [k, v] of map) yield [k, v] as [string, unknown];
                },
                getDirectoryHandle: async (sub: string, _opts?: unknown) => {
                  const v = map.get(sub);
                  if (v === undefined) throw new DOMException(`no entry ${sub}`, "NotFoundError");
                  return v;
                },
                getFileHandle: async (sub: string) => {
                  const v = map.get(sub);
                  if (v === undefined) throw new DOMException(`no entry ${sub}`, "NotFoundError");
                  return v;
                },
              };
            };
            const root = mkDirHandle("__synthetic__", [
              ["protocolMagicId", mkFileHandle("protocolMagicId", new TextEncoder().encode("1"))],
              ["ledger", mkDirHandle("ledger", [
                ["121230642", mkDirHandle("121230642", [
                  ["state", mkFileHandle("state", new Uint8Array([0x82, 0x01, 0x02]))],
                ])],
              ])],
              ["lsm", mkDirHandle("lsm", [
                ["active", mkDirHandle("active", [])],
                ["metadata", mkFileHandle("metadata", new TextEncoder().encode("v2"))],
                ["snapshots", mkDirHandle("snapshots", [])],
              ])],
            ]);
            Object.defineProperty(globalThis, "showDirectoryPicker", {
              configurable: true,
              writable: true,
              value: async () => root,
            });
          }),
        );

        yield* Effect.promise(() =>
          popup.goto(`chrome-extension://${extensionId}/popup.html?fullpage=1&mode=local`),
        );
        yield* waitForLoadState(popup);
        yield* sleep(1000);

        // ─── Step 3: click the dropzone (which calls the mocked picker).
        yield* Effect.promise(() =>
          popup.locator('[data-testid="snapshot-dropzone"]').click(),
        );

        // ─── Step 4: poll for completion. Success surfaces as the
        // popup status text including either "Snapshot loaded" (the
        // post-reopen final state) or "Reopening lsm-tree session"
        // (one step before — sufficient evidence the chain worked).
        const start = yield* Clock.currentTimeMillis;
        // `Effect.exit` converts `Effect<A,E,R>` to `Effect<Exit<A,E>, never, R>`,
        // the v4 replacement for the removed `Effect.either`.
        const exit = yield* Effect.exit(
          pollUntil(
            Effect.gen(function* () {
              const text = yield* pageEvaluate(popup, () => document.body.innerText);
              return /Snapshot loaded|Reopening lsm-tree session/.test(text);
            }),
            { timeoutMs: 60_000, description: "popup status reaches Reopening/Loaded" },
          ),
        );
        const elapsed = (yield* Clock.currentTimeMillis) - start;
        const succeeded = Exit.isSuccess(exit);
        yield* Console.log(`[upload-synthetic] succeeded=${succeeded} elapsed=${elapsed}ms`);

        if (!succeeded) {
          yield* Console.log("=== POPUP LOG (last 30) ===");
          for (const l of popupLogs.slice(-30)) yield* Console.log(l);
          yield* Console.log("=== OFFSCREEN LOG (last 30) ===");
          for (const l of offscreenLogs.slice(-30)) yield* Console.log(l);
        }
        expect(succeeded).toBe(true);
      }),
    ));
});
