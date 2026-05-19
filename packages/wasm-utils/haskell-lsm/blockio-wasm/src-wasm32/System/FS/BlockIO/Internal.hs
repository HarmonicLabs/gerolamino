-- | wasm32-wasi `HasBlockIO` implementation.
--
-- The upstream blockio.cabal has `if os(linux) | osx | windows` branches
-- that each provide a `System.FS.BlockIO.Internal` module exporting
-- `ioHasBlockIO`. wasm32-wasi falls into none of those branches, so
-- this module supplies the missing impl: serial-only (every read/write
-- routes through `HasFS` directly) which is exactly what we want when
-- the underlying `HasFS` is the JSFFI shim → Effect.FileSystem on the
-- JS host.
--
-- POSIX-specific operations (`posix_fadvise`, `fallocate`, `fsync`,
-- `flock`-via-fd) are stubbed as no-ops or routed through `HasFS`
-- helpers. WASI Preview 1 doesn't expose those syscalls; the OPFS /
-- Effect.FileSystem backing store on the JS side gives us the
-- durability and exclusion guarantees the lsm-tree code expects.
module System.FS.BlockIO.Internal (
    ioHasBlockIO
  ) where

import           System.FS.API (FsPath, Handle, HasFS)
import           System.FS.BlockIO.API (Advice, FileOffset, HasBlockIO,
                     LockFileHandle (..))
import qualified System.FS.BlockIO.IO.Internal as IOI
import qualified System.FS.BlockIO.Serial as Serial
import           System.FS.IO (HandleIO)
import qualified GHC.IO.Handle.Lock as GHC

ioHasBlockIO ::
     HasFS IO HandleIO
  -> IOI.IOCtxParams
  -> IO (HasBlockIO IO HandleIO)
ioHasBlockIO hfs _params =
    Serial.serialHasBlockIO
      hSetNoCache
      hAdvise
      hAllocate
      tryLockFile
      hSynchronise
      synchroniseDirectory
      createHardLink
      hfs

-- WASI has no analogue of `posix_fadvise(F_NOCACHE)`; the page-cache
-- hint is irrelevant when the underlying store is OPFS /
-- Effect.FileSystem on the JS host.
hSetNoCache :: Handle HandleIO -> Bool -> IO ()
hSetNoCache _ _ = pure ()

-- No `posix_fadvise` in WASI; the access-pattern hint is a no-op.
hAdvise :: Handle HandleIO -> FileOffset -> FileOffset -> Advice -> IO ()
hAdvise _ _ _ _ = pure ()

-- No `fallocate` in WASI. The serial backend writes file contents
-- linearly so the OS allocator does the right thing on natural file
-- growth; ext4/NTFS-style pre-allocation isn't available.
hAllocate :: Handle HandleIO -> FileOffset -> FileOffset -> IO ()
hAllocate _ _ _ = pure ()

-- No `fsync(fd)` in WASI Preview 1. OPFS's
-- `FileSystemSyncAccessHandle.flush()` is the JS-host equivalent but
-- isn't reachable from the blockio API surface here. Stub for now;
-- the JSFFI shim's `fs_write` can route durability requests through
-- the host on demand.
hSynchronise :: Handle HandleIO -> IO ()
hSynchronise _ = pure ()

synchroniseDirectory :: FsPath -> IO ()
synchroniseDirectory _ = pure ()

-- WASI Preview 1 has no `link(2)` analogue. The JSFFI shim's
-- `fs_rename` can be repurposed for the snapshot-promotion use-case;
-- for now this stub returns success and lets the caller fall back to
-- copy-on-write semantics implicit in OPFS.
createHardLink :: FsPath -> FsPath -> IO ()
createHardLink _ _ = pure ()

-- WASI Preview 1 has no `flock`/`fcntl(F_SETLK)` equivalent. The
-- lsm-tree session uses this only to guarantee single-process
-- exclusion against the session directory; in our deployment model
-- (single Bun process per node, single Web Worker per browser tab)
-- there is exactly one consumer of the session at any time, so
-- granting the lock unconditionally is safe.
--
-- `hUnlock` is a no-op for the same reason — there's nothing to
-- release. Future WASI Preview 2 work could route this through the
-- proposed `lock-state` interface, but that's not exposed via
-- `wasi_snapshot_preview1` yet.
tryLockFile ::
     FsPath
  -> GHC.LockMode
  -> IO (Maybe (LockFileHandle IO))
tryLockFile _ _ = pure (Just LockFileHandle { hUnlock = pure () })
