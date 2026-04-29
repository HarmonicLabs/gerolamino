/**
 * PostCSS configuration for the WXT/Vite popup pipeline.
 *
 * Without this, Vite passes the dashboard's `@import "tailwindcss"` and
 * `@theme inline` directives through verbatim — so the popup CSS ends
 * up missing every utility (`text-foreground`, `bg-background`, etc.)
 * the dashboard components rely on, and text falls back to the
 * browser-default black on a black background.
 *
 * `@tailwindcss/postcss` is the canonical Tailwind v4 PostCSS plugin;
 * it processes the `@import` + `@theme` + `@source` directives in
 * `dashboard/src/styles.css` and emits the full utility set scanned
 * from the dashboard's components AND the popup's own entrypoints.
 */
module.exports = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
