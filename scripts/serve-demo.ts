#!/usr/bin/env bun
/**
 * Serve the dApp demo page (examples/dapp-demo.html) on http://127.0.0.1:<port>/ so the extension's content scripts
 * run on it (they match http and https pages, not file://).
 *
 *   bun scripts/serve-demo.ts [--port 8787]
 */
const i = process.argv.indexOf("--port");
const port = i > 0 ? Number(process.argv[i + 1]) : 8787;
const page = Bun.file(new URL("../examples/dapp-demo.html", import.meta.url));
const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }) });
console.log(`dApp demo on http://127.0.0.1:${server.port}/`);
