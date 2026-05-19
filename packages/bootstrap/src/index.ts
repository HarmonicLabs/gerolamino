/**
 * `bootstrap` package — Mithril V2LSM snapshot helpers.
 *
 * After the apps/bootstrap server deletion, this package is purely
 * about Mithril snapshot LAYOUT — the constants + walkers + readers
 * that let any host (Node-FS for the TUI, FS Access API for chrome-ext)
 * consume the same V2LSM directory shape.
 *
 *   - `./snapshot.ts` — Effect FileSystem-based reader (Node/Bun).
 *   - `./walker.ts`   — browser FS-Access-API walker (drag-drop).
 *   - both share the layout constants (`REQUIRED_TOP_LEVEL`,
 *     `REQUIRED_LSM_ENTRIES`, `SLOT_DIR_RE`, `NETWORK_MAGIC`) from
 *     `./snapshot.ts`.
 */
export * from "./snapshot.ts";
export * from "./walker.ts";
