#!/usr/bin/env bun
/**
 * Serve the docs landing page and raw Markdown over localhost.
 *
 *   bun run docs-serve [--port 8788]
 */
import { resolve } from "node:path";

const portArg = process.argv.indexOf("--port");
const port = portArg > 0 ? Number(process.argv[portArg + 1]) : 8788;
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error("invalid --port");
  process.exit(1);
}

const root = resolve(import.meta.dir, "..", "docs");
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function fileFor(pathname: string): string | null {
  const clean = decodeURIComponent(pathname).replace(/\\/g, "/");
  if (clean.includes("../") || clean.includes("/..")) return null;
  const rel = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  const file = resolve(root, rel);
  if (!file.startsWith(root + "/") && file !== root) return null;
  return file;
}

function contentType(file: string): string {
  const dot = file.lastIndexOf(".");
  return mime[file.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const file = fileFor(url.pathname);
    if (!file) return new Response("not found", { status: 404 });
    const body = Bun.file(file);
    if (!(await body.exists())) return new Response(`not found: ${url.pathname}`, { status: 404 });
    return new Response(body, {
      headers: {
        "content-type": contentType(file),
        "cache-control": "no-cache",
      },
    });
  },
});

console.log(`Gerolamino docs on http://127.0.0.1:${server.port}/`);
