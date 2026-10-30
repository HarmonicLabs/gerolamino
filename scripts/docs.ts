#!/usr/bin/env bun
/**
 * Build the docs landing page: docs/index.html.
 *
 *   bun run docs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

type DocManifest = {
  title: string;
  tagline: string;
  categories: {
    title: string;
    description: string;
    docs: { file: string; title: string; summary: string }[];
  }[];
};

type DocEntry = {
  file: string;
  title: string;
  summary: string;
  category: string;
  slug: string;
};

const root = resolve(import.meta.dir, "..");
const docsRoot = join(root, "docs");
const manifestPath = join(docsRoot, "docs.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DocManifest;

const entries: DocEntry[] = [];
for (const category of manifest.categories) {
  for (const doc of category.docs) {
    entries.push({
      file: doc.file,
      title: doc.title,
      summary: doc.summary,
      category: category.title,
      slug: slugFor(doc.file),
    });
  }
}

const byFile = new Map(entries.map((entry) => [entry.file, entry]));

function slugFor(file: string): string {
  return file
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function rewriteDocLinks(html: string): string {
  return html.replace(/href="([^"]+\.md)"/gi, (whole, href: string) => {
    if (/^https?:/i.test(href) || href.startsWith("#")) return whole;
    const file = basename(href.split(/[?#]/)[0]);
    const target = byFile.get(file);
    return target ? `href="#${target.slug}"` : whole;
  });
}

const sections = entries.map((entry) => {
  const markdown = readFileSync(join(docsRoot, entry.file), "utf8");
  const body = rewriteDocLinks(Bun.markdown.html(markdown));
  return `
<article class="doc" id="${entry.slug}" data-search="${escapeHtml(`${entry.title} ${entry.summary}`)}">
  <header class="doc-header">
    <div class="doc-category">${escapeHtml(entry.category)}</div>
    <h2>${escapeHtml(entry.title)}</h2>
    <p class="doc-summary">${escapeHtml(entry.summary)}</p>
    <div class="doc-actions">
      <a class="source-link" href="./${entry.file}" target="_blank" rel="noopener">Open raw Markdown</a>
      <a class="source-link" href="#${entry.slug}">Jump to section</a>
    </div>
  </header>
  <div class="doc-body">${body}</div>
</article>`;
});

const nav = manifest.categories.map((category) => {
  const links = category.docs.map((doc) => {
    const entry = byFile.get(doc.file);
    if (!entry) return "";
    return `<a class="nav-link" href="#${entry.slug}" data-doc="${entry.slug}" data-title="${escapeHtml(entry.title)}">${escapeHtml(entry.title)}</a>`;
  }).join("");
  return `
<section class="nav-category">
  <div class="nav-title">${escapeHtml(category.title)}</div>
  <div class="nav-docs">${links}</div>
</section>`;
}).join("");

const firstSlug = entries[0]?.slug ?? "docs";
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(manifest.title)}</title>
<style>
:root {
  --bg: #0b1015;
  --panel: #111a21;
  --panel-soft: #0f171e;
  --text: #e7edf1;
  --muted: #9aa8b2;
  --dim: #65747f;
  --line: #24313b;
  --accent: #ff8b4a;
  --accent-soft: #ffb07a;
  --ok: #71d7a6;
  --bad: #ff7f7f;
  --code: #0b1319;
  --shadow: 0 20px 60px rgba(0, 0, 0, .28);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background:
    radial-gradient(1200px 600px at 10% -10%, rgba(255, 139, 74, .08), transparent 55%),
    radial-gradient(800px 500px at 90% 0%, rgba(113, 215, 166, .04), transparent 50%),
    var(--bg);
  color: var(--text);
  font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  min-height: 100vh;
}
a { color: var(--accent-soft); text-decoration: none; }
a:hover { color: #ffd0a8; }
a:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
code, pre, kbd { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
code {
  color: #f5c6a6;
  background: rgba(255, 139, 74, .09);
  border: 1px solid rgba(255, 139, 74, .12);
  border-radius: 5px;
  padding: 1px 4px;
}
pre {
  overflow-x: auto;
  background: var(--code);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 14px;
  margin: 14px 0;
  box-shadow: 0 12px 36px rgba(0, 0, 0, .22);
}
pre code {
  background: transparent;
  border: 0;
  padding: 0;
  color: var(--text);
}
.skip {
  position: absolute;
  left: -9999px;
  top: 12px;
  z-index: 100;
  background: var(--accent);
  color: var(--bg);
  border-radius: 6px;
  padding: 8px 12px;
  font-weight: 700;
}
.skip:focus { left: 16px; }
.layout {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 30px;
    max-width: 1320px;
  margin: 0 auto;
  padding: 34px 24px 60px;
}
.sidebar {
  position: sticky;
  top: 24px;
  align-self: start;
  overflow: auto;
  max-height: calc(100vh - 48px);
  background: rgba(17, 26, 33, .88);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: var(--shadow);
  padding: 20px 16px;
  backdrop-filter: blur(10px);
}
.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding-bottom: 13px;
  border-bottom: 1px solid var(--line);
}
.mark {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: linear-gradient(135deg, #ff8b4a, #b7642f);
  box-shadow: 0 4px 18px rgba(255, 139, 74, .22);
  display: grid;
  place-items: center;
  color: #141c22;
  font-weight: 900;
}
.brand strong { font-size: 17px; letter-spacing: .01em; }
.kicker {
  color: var(--dim);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .14em;
  text-transform: uppercase;
}
.tagline { color: var(--muted); font-size: 12px; margin: 4px 0 0; }
.filter-wrap {
  margin: 18px 0;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--panel-soft);
}
.filter {
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  padding: 7px 8px;
}
.filter::placeholder { color: var(--dim); }
.nav-category { margin: 14px 0; }
.nav-title {
  color: var(--dim);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
  margin-bottom: 5px;
}
.nav-docs { display: grid; gap: 2px; }
.nav-link {
  display: block;
  color: var(--muted);
  font-size: 13px;
  padding: 4px 7px;
  border-radius: 6px;
  border-left: 2px solid transparent;
  overflow-wrap: anywhere;
}
.nav-link:hover { color: var(--text); background: rgba(255, 255, 255, .04); }
.nav-link.active { color: var(--accent-soft); background: rgba(255, 139, 74, .1); border-left-color: var(--accent); font-weight: 600; }
.sidebar-foot {
  margin-top: 18px;
  padding-top: 13px;
  border-top: 1px solid var(--line);
  color: var(--dim);
  font-size: 11px;
  line-height: 1.5;
}
.main { min-width: 0; }
.hero {
  background: rgba(17, 26, 33, .9);
  border: 1px solid var(--line);
  border-radius: 20px;
  padding: 28px;
  margin-bottom: 24px;
  box-shadow: var(--shadow);
}
.eyebrow {
  color: var(--accent);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .18em;
  text-transform: uppercase;
  margin-bottom: 9px;
}
h1 {
  font-size: clamp(30px, 4vw, 52px);
  line-height: 1.02;
  letter-spacing: -.035em;
  margin: 0;
  max-width: 680px;
  background: linear-gradient(90deg, #f7f2ea, #b8c2c7);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.hero p {
  color: var(--muted);
  font-size: 15px;
  max-width: 640px;
  margin: 14px 0 0;
}
.hero-links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
.hero-link {
  border: 1px solid rgba(255, 139, 74, .28);
  background: rgba(255, 139, 74, .08);
  border-radius: 999px;
  color: var(--accent-soft);
  font-size: 12px;
  padding: 7px 12px;
}
.hero-link.quiet { border-color: var(--line); background: rgba(255,255,255,.025); color: var(--muted); }
.stack {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 22px;
  color: var(--dim);
  font-size: 12px;
}
.stack span {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 3px 7px;
  background: rgba(255,255,255,.02);
}
.doc {
  scroll-margin-top: 18px;
  background: rgba(17, 26, 33, .86);
  border: 1px solid var(--line);
  border-radius: 17px;
  margin: 0 0 22px;
  box-shadow: 0 12px 44px rgba(0, 0, 0, .18);
}
.doc[hidden] { display: none !important; }
.doc-header { padding: 24px 26px 0; }
.doc-category {
  color: var(--dim);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .13em;
  text-transform: uppercase;
}
.doc h2 {
  font-size: 24px;
  letter-spacing: -.02em;
  margin: 5px 0 6px;
}
.doc-summary { color: var(--muted); margin: 0; max-width: 760px; font-size: 13.5px; }
.doc-actions { display: flex; gap: 14px; margin-top: 12px; }
.source-link { font-size: 11px; color: var(--dim); }
.source-link:hover { color: var(--accent-soft); }
.doc-body { padding: 5px 26px 24px; color: #d8e1e6; overflow-wrap: anywhere; }
.doc-body > h1:first-child { display: none; }
.doc-body h2 {
  color: var(--text);
  font-size: 17px;
  letter-spacing: -.01em;
  margin: 24px 0 8px;
  padding-top: 4px;
  border-top: 1px solid rgba(36, 49, 59, .7);
}
.doc-body h3 { color: var(--accent-soft); font-size: 14px; margin: 18px 0 6px; }
.doc-body p { margin: 9px 0; }
.doc-body ul, .doc-body ol { padding-left: 22px; margin: 8px 0; }
.doc-body li { margin: 4px 0; }
.doc-body table {
  width: 100%;
  border-collapse: collapse;
  margin: 14px 0;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}
.doc-body th, .doc-body td { padding: 8px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
.doc-body th { color: var(--accent-soft); background: rgba(255, 139, 74, .06); font-size: 11px; letter-spacing: .03em; }
.doc-body tr:last-child td { border-bottom: 0; }
.doc-body hr { border: 0; border-top: 1px solid var(--line); margin: 22px 0; }
.doc-body blockquote { border-left: 2px solid var(--accent); color: var(--muted); margin: 12px 0; padding: 2px 0 2px 12px; }
.empty {
  color: var(--muted);
  text-align: center;
  padding: 48px 20px;
  border: 1px dashed var(--line);
  border-radius: 14px;
  margin: 22px 0;
}
.footer {
  color: var(--dim);
  font-size: 12px;
  padding: 8px 4px;
}
.footer p { margin: 5px 0; }
@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; gap: 18px; padding: 20px 14px 50px; }
  .sidebar { position: static; max-height: none; }
  .hero { padding: 22px; }
  .doc-header { padding: 22px 18px 0; }
  .doc-body { padding: 5px 18px 20px; }
  .hero h1 { max-width: 100%; }
}
@media print {
  body { background: white; color: #111; }
  .sidebar, .hero-links, .stack, .filter-wrap, .doc-actions, .footer, .skip { display: none !important; }
  .layout { display: block; max-width: none; padding: 0; }
  .doc, .hero { box-shadow: none; border-color: #ccc; break-inside: avoid; }
  .doc-body { color: #111; }
  .doc-body h2 { color: #111; }
  .doc-body th { color: #111; background: #f4f4f4; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  * { transition: none !important; animation: none !important; }
}
</style>
</head>
<body>
<a class="skip" href="#${firstSlug}">Skip to documents</a>
<div class="layout">
  <aside class="sidebar">
    <div class="brand">
      <div class="mark">G</div>
      <div>
        <div class="kicker">Harmonic Labs</div>
        <strong>${escapeHtml(manifest.title)}</strong>
        <div class="tagline">${escapeHtml(manifest.tagline)}</div>
      </div>
    </div>
    <div class="filter-wrap">
      <input id="doc-filter" class="filter" type="search" placeholder="Filter documents..." aria-label="Filter documents">
    </div>
    <nav class="docs-nav" aria-label="Documentation">
      ${nav}
    </nav>
    <div class="sidebar-foot">
      <span id="doc-count">${entries.length} documents</span>
      <br>Build with <code>bun run docs</code><br>
      Serve with <code>bun run docs-serve</code>
    </div>
  </aside>
  <main class="main" id="top">
    <section class="hero">
      <div class="eyebrow">Documentation index</div>
      <h1>Build, load, query, and verify Gerolamino.</h1>
      <p>${escapeHtml(manifest.tagline)} Read the extension install path, the browser dApp API, the local UTxO ledger contract, and the measured status of the node.</p>
      <div class="hero-links">
        <a class="hero-link" href="#install-extension">Start with the extension</a>
        <a class="hero-link" href="#dapp-api">dApp API</a>
        <a class="hero-link" href="#ledger-spec">Ledger P0</a>
        <a class="hero-link quiet" href="#status">Status</a>
      </div>
      <div class="stack">
        <span>MV3 browser extension</span>
        <span>N2N over WebSocket</span>
        <span>OPFS storage</span>
        <span>Local UTxO P0</span>
        <span>Blockfrost-shaped API</span>
      </div>
    </section>
    <div id="doc-empty" class="empty" hidden>No documents match that filter.</div>
    ${sections.join("")}
    <footer class="footer">
      <p>Generated from <code>docs/docs.json</code> and the Markdown beside this page.</p>
      <p>This page is self-contained. Open <code>docs/index.html</code> directly, or run <code>bun run docs-serve</code>.</p>
    </footer>
  </main>
</div>
<script>
(() => {
  const filter = document.getElementById("doc-filter");
  const count = document.getElementById("doc-count");
  const empty = document.getElementById("doc-empty");
  const sections = Array.from(document.querySelectorAll("article.doc"));
  const navLinks = Array.from(document.querySelectorAll("a.nav-link[data-doc]"));
  const navById = new Map(navLinks.map((link) => [link.dataset.doc, link]));
  const all = sections.length;

  const setCount = (visible) => {
    count.textContent = filter.value.trim()
      ? \`\${visible} of \${all} documents\`
      : \`\${all} documents\`;
    empty.hidden = !(filter.value.trim() && visible === 0);
  };

  const applyFilter = () => {
    const query = filter.value.trim().toLowerCase();
    let visible = 0;
    for (const section of sections) {
      const haystack = section.textContent.toLowerCase();
      const matches = !query || haystack.includes(query);
      section.hidden = !matches;
      const link = navById.get(section.id);
      if (link) link.hidden = !matches;
      if (matches) visible += 1;
    }
    setCount(visible);
  };

  filter.addEventListener("input", applyFilter);

  const makeActive = () => {
    let active = sections[0]?.id;
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= 96) active = section.id;
    }
    for (const link of navLinks) {
      const isActive = link.dataset.doc === active;
      link.classList.toggle("active", isActive);
      if (isActive) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  };
  window.addEventListener("scroll", makeActive, { passive: true });
  window.addEventListener("hashchange", () => setTimeout(makeActive, 50));
  makeActive();
  setCount(all);
})();
</script>
</body>
</html>
`;

const out = join(docsRoot, "index.html");
const cleaned = html.replace(/[ \t]+$/gm, "");
writeFileSync(out, cleaned, "utf8");
console.log(`wrote ${out} (${(cleaned.length / 1024).toFixed(1)} KiB, ${entries.length} docs)`);
