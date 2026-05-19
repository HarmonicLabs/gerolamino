# bootstrap (package)

Mithril V2LSM snapshot layout helpers — host-agnostic constants
plus two readers (Effect FileSystem for Bun/Node, FS Access API for
the browser).

## Structure

```
src/
  index.ts        <- re-exports
  snapshot.ts     <- layout constants + Effect FileSystem reader (Node/Bun)
  walker.ts       <- browser-side FS Access API walker (drag-drop)
  __tests__/      <- snapshot.test.ts
```

## Dependencies

- `effect` ^4.0.0-beta.47+

## Notes

The `apps/bootstrap` server has been deleted (May 2026). This package
no longer ships a wire protocol — only the V2LSM directory layout
constants (`REQUIRED_TOP_LEVEL`, `REQUIRED_LSM_ENTRIES`, `SLOT_DIR_RE`,
`NETWORK_MAGIC`) and two readers that consume them:

- **Node/Bun** (`apps/tui`) — `readSnapshotMeta`, `readLedgerStateBytes`,
  `findLatestLsmSnapshot`, `prepareLsmSession`, `readNodeDbMeta` via
  Effect's `FileSystem` service.
- **Browser** (`packages/chrome-ext`) — `walkSnapshotDirectory`,
  `validateSnapshotHandle` via the File System Access API. The popup's
  drag-drop uploader pairs each enumerated file with its OPFS
  destination path.

## Testing

```sh
bunx --bun vitest run packages/bootstrap
```
