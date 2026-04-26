/**
 * `cn` — Tailwind classname merger.
 *
 * The canonical shadcn / solid-ui pattern: `clsx` resolves conditional class
 * arrays into a single space-separated string, then `tailwind-merge` resolves
 * Tailwind class conflicts intelligently (e.g., `tw-merge("p-4 p-2") === "p-2"`).
 *
 * Every primitive + component in the dashboard composes user-supplied `class`
 * with internal defaults via `cn(internalDefaults, userClass)`, so consumers
 * can override styling without losing the primitive's semantic baseline.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
