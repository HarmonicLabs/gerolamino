/**
 * Mithril ledger-state discovery + read via Effect `FileSystem` (OPFS root).
 */
import { SLOT_DIR_RE } from "bootstrap";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";

/** Path to tip-most `ledger/<slot>/state`, or `undefined` for genesis mode. */
export const findLatestLedgerStatePath: Effect.Effect<
  string | undefined,
  PlatformError,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const hasLedger = yield* fs.exists("ledger");
  if (!hasLedger) return undefined;

  const entries = yield* fs.readDirectory("ledger");
  const slots: Array<{ name: string; slot: bigint }> = [];
  for (const name of entries) {
    const m = SLOT_DIR_RE.exec(name);
    if (m === null || m[1] === undefined) continue;
    slots.push({ name, slot: BigInt(m[1]) });
  }
  if (slots.length === 0) return undefined;
  slots.sort((a, b) => (b.slot > a.slot ? 1 : b.slot < a.slot ? -1 : 0));
  return `ledger/${slots[0]!.name}/state`;
});

/** Raw ExtLedgerState CBOR bytes from OPFS, or `undefined` when absent. */
export const readLatestLedgerStateBytes: Effect.Effect<
  Uint8Array | undefined,
  PlatformError,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const path = yield* findLatestLedgerStatePath;
  if (path === undefined) return undefined;
  return yield* (yield* FileSystem.FileSystem).readFile(path);
});
