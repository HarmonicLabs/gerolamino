#!/usr/bin/env bun
/**
 * Diagnostic: launch the built extension, start a genesis sync, and print the offscreen document's console
 * output and uncaught errors (the Playwright trace does not capture the offscreen target).
 *
 *   CHROMIUM_PATH=<chrome-for-testing> GEROLAMINO_RELAY_URL=ws://host:port bun e2e/diag-offscreen-console.ts [seconds]
 */
import { chromium } from "@playwright/test";
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installE2eDeferBootstrap, installE2eDirectOffscreenRpc, readSessionLogs, triggerGenesisStartSync } from "./extension-helpers.ts";

const EXT = join(import.meta.dirname, "../.output/chrome-mv3-dev");
const seconds = Number(process.argv[2] ?? "60");
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "gero-diag-")), {
  executablePath: process.env.CHROMIUM_PATH,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--disable-gpu"],
});
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const watch = (p: { url(): string; on: Function }) => {
  const u = p.url();
  p.on("console", (m: any) => console.log(`${stamp()} [console ${u.split("/").pop()}] ${m.type()}: ${m.text()}`.slice(0, 600)));
  p.on("pageerror", (e: any) => console.log(`${stamp()} [pageerror ${u.split("/").pop()}] ${e?.stack ?? e}`.slice(0, 1500)));
};
ctx.on("page", (p) => { console.log(`${stamp()} page opened: ${p.url()}`); watch(p as any); });
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15_000 });
sw.on("console", (m: any) => console.log(`${stamp()} [sw] ${m.type()}: ${m.text()}`.slice(0, 600)));
const extensionId = sw.url().split("/")[2]!;
await Effect.runPromise(installE2eDeferBootstrap(ctx));
await Effect.runPromise(installE2eDirectOffscreenRpc(ctx));
const probe = await ctx.newPage();
await probe.goto(`chrome-extension://${extensionId}/popup.html`);
await Effect.runPromise(triggerGenesisStartSync(ctx, extensionId, probe));
console.log(`${stamp()} pages: ${ctx.pages().map((p) => p.url()).join(" | ")}`);
for (const p of ctx.pages()) if (p.url().includes("offscreen")) watch(p as any);
// the offscreen document is not a Playwright page: attach over CDP and relay Runtime/Log events
const cdp = await ctx.newCDPSession(probe);
const { targetInfos } = (await cdp.send("Target.getTargets")) as any;
const off = targetInfos.find((t: any) => String(t.url).includes("offscreen"));
console.log(`${stamp()} offscreen target: ${off?.url ?? "none"} (${off?.type})`);
if (off) {
  const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId: off.targetId, flatten: false })) as any;
  let id = 0;
  const send = (method: string, params: object = {}) => cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: ++id, method, params }) } as any);
  cdp.on("Target.receivedMessageFromTarget" as any, (e: any) => {
    const m = JSON.parse(e.message);
    if (m.method === "Runtime.consoleAPICalled") console.log(`${stamp()} [offscreen ${m.params.type}] ${m.params.args.map((x: any) => x.value ?? x.description ?? "").join(" ")}`.slice(0, 800));
    else if (m.method === "Runtime.exceptionThrown") console.log(`${stamp()} [offscreen EXCEPTION] ${JSON.stringify(m.params.exceptionDetails).slice(0, 2000)}`);
    else if (m.method === "Log.entryAdded") console.log(`${stamp()} [offscreen log ${m.params.entry.level}] ${m.params.entry.text} ${m.params.entry.url ?? ""}`.slice(0, 800));
  });
  await send("Runtime.enable"); await send("Log.enable");
}
await new Promise((r) => setTimeout(r, seconds * 1000));
if (off) {
  const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId: off.targetId, flatten: false })) as any;
  const results = new Map<number, any>();
  cdp.on("Target.receivedMessageFromTarget" as any, (e: any) => { const m = JSON.parse(e.message); if (m.id) results.set(m.id, m); });
  const expr = "(async () => { const out = []; try { const url = '/assets/wasm_utils_bg-BXiavNMT.wasm'; const m = await WebAssembly.compileStreaming(fetch(url)); const imps = WebAssembly.Module.imports(m); out.push(JSON.stringify(imps)); out.push('exports ' + WebAssembly.Module.exports(m).length + ' start? ' + WebAssembly.Module.exports(m).some(e => /start/.test(e.name))); const im = {}; for (const i of imps) { im[i.module] ??= {}; im[i.module][i.name] = () => {}; } const t0 = performance.now(); const inst = await WebAssembly.instantiate(m, im); out.push('instantiated in ' + Math.round(performance.now() - t0) + ' ms'); } catch (e) { out.push('ERR ' + (e && e.stack || e)); } return out.join(' | '); })()";
  await cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: 9001, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }) } as any);
  await new Promise((r) => setTimeout(r, 8000));
  console.log("EVAL", JSON.stringify(results.get(9001)?.result?.result?.value ?? results.get(9001)).slice(0, 1500));
}
const logs = await Effect.runPromise(readSessionLogs(probe));
console.log(`---- session log tail (${logs.length} lines)`);
for (const l of logs.slice(-25)) console.log(l.slice(0, 300));
await ctx.close();
