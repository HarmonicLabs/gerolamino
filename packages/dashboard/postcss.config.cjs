/**
 * PostCSS pipeline for the dashboard package.
 *
 * Tailwind v4 ships its own PostCSS plugin (`@tailwindcss/postcss`); paired
 * with `autoprefixer` for older Chromium / WebKit targets. Consumers
 * (`apps/tui` Bun.WebView host, `packages/chrome-ext` WXT popup) inherit
 * this config when they import `dashboard/styles.css` through their own
 * Vite/PostCSS pipelines, so no per-host duplication is required.
 */
module.exports = {
  plugins: {
    "@tailwindcss/postcss": {},
    autoprefixer: {},
  },
};
