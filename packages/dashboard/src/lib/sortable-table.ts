/** Maps TanStack `getIsSorted()` to WAI-ARIA `aria-sort` values. */
export const ariaSortValue = (sorted: false | "asc" | "desc"): "none" | "ascending" | "descending" =>
  sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none";

/** Visible sort direction glyph for sortable column headers. */
export const sortIndicator = (sorted: false | "asc" | "desc"): string =>
  sorted === "asc" ? " ▲" : sorted === "desc" ? " ▼" : "";
