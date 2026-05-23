/**
 * Structured logging for the popup snapshot-upload pipeline.
 *
 * Uses Effect's logger (not `console.*`) so lines flow through
 * `TestLogBufferLayer` in SW/offscreen and remain grep-friendly in
 * manual QA (`[snapshot-upload] …`).
 */
import { Effect } from "effect";

const PREFIX = "[snapshot-upload]";

export const snapshotUploadLog = (message: string): Effect.Effect<void> =>
  Effect.logInfo(`${PREFIX} ${message}`);

export const snapshotUploadError = (message: string): Effect.Effect<void> =>
  Effect.logError(`${PREFIX} ${message}`);
