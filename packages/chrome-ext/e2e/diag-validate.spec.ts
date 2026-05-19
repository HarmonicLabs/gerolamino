/**
 * Diagnostic — confirms `getDirectoryHandle().entries()` round-trips
 * a seeded OPFS layout. Test body uses Effect for the page lifecycle
 * and `Console.log` for the structured-result dump.
 */
import { Console, Effect } from "effect";
import { test } from "./fixtures.ts";
import { pageEvaluate, runE } from "./effect-helpers.ts";

test("diagnose whether OPFS getDirectoryHandle().entries() works", async ({
  context,
  extensionId,
}) =>
  runE(
    Effect.gen(function* () {
      const page = yield* Effect.promise(() => context.newPage());
      yield* Effect.promise(() =>
        page.goto(`chrome-extension://${extensionId}/popup.html?fullpage=1`),
      );
      const result = yield* pageEvaluate(page, async () => {
        const log: string[] = [];
        try {
          log.push("getting root");
          const root = await navigator.storage.getDirectory();
          log.push("seeding __fixture__");
          const fixture = await root.getDirectoryHandle("__fixture__", { create: true });
          const writeFile = async (
            dir: FileSystemDirectoryHandle,
            name: string,
            data: BufferSource,
          ) => {
            const file = await dir.getFileHandle(name, { create: true });
            const w = await file.createWritable();
            await w.write(data);
            await w.close();
          };
          await writeFile(fixture, "protocolMagicId", new TextEncoder().encode("1"));
          const ledger = await fixture.getDirectoryHandle("ledger", { create: true });
          const slot = await ledger.getDirectoryHandle("121230642", { create: true });
          await writeFile(slot, "state", new Uint8Array([0x82, 0x01, 0x02]));
          const lsm = await fixture.getDirectoryHandle("lsm", { create: true });
          await lsm.getDirectoryHandle("active", { create: true });
          await writeFile(lsm, "metadata", new TextEncoder().encode("v2"));
          await lsm.getDirectoryHandle("snapshots", { create: true });
          log.push("seed complete");
          log.push("reading top-level entries");
          const topEntries: string[] = [];
          for await (const [n] of (fixture as FileSystemDirectoryHandle).entries()) {
            topEntries.push(n);
          }
          log.push(`top entries: ${topEntries.join(",")}`);
          log.push("reading lsm entries");
          const lsmEntries: string[] = [];
          for await (const [n] of (lsm as FileSystemDirectoryHandle).entries()) {
            lsmEntries.push(n);
          }
          log.push(`lsm entries: ${lsmEntries.join(",")}`);
          return { ok: true, log };
        } catch (e) {
          log.push(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
          return { ok: false, log };
        }
      });
      yield* Console.log(JSON.stringify(result, null, 2));
    }),
  ));
