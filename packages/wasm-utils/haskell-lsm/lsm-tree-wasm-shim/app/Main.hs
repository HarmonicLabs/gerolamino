{-# LANGUAGE BangPatterns #-}
{-# LANGUAGE ForeignFunctionInterface #-}
{-# LANGUAGE JavaScriptFFI #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE TypeApplications #-}

-- | Reactor entrypoints for the wasm32-wasi lsm-tree shim.
--
-- The WASM module is built with `-mexec-model=reactor` + `-no-hs-main`
-- — no traditional `main`, just a table of `foreign export javascript
-- "hs_lsm_* sync"` declarations the JS host calls directly. The JS
-- host is responsible for calling `hs_init` once on startup.
--
-- Filesystem access goes through `wasi_snapshot_preview1` (provided
-- by Node's `node:wasi` for the TUI build, or `@bjorn3/browser_wasi_shim`
-- backed by OPFS for the chrome-ext build). lsm-tree's upstream
-- `System.FS.IO.Unix` HasFS instance compiles cleanly on wasm32-wasi —
-- the `unix` package's POSIX FFI maps directly onto WASI syscalls. No
-- bespoke JSFFI HasFS layer is required.
--
-- The locally-vendored `blockio-wasm` package supplies a wasm32-wasi
-- `System.FS.BlockIO.Internal` that:
--   * routes every I/O through `Serial.serialHasBlockIO` (no
--     io_uring/async on wasm32);
--   * stubs `posix_fadvise` / `fallocate` / `fsync` / `link(2)` as
--     no-ops (none exist in WASI Preview 1);
--   * grants `tryLockFile` unconditionally (single Bun process /
--     single Web Worker → exclusive use guaranteed by the runtime).
--
-- Handle model: JS-callable reactors return + accept `Word32`
-- handles. The Haskell side maintains an `IORef (IntMap Resource)`
-- with a `MVar` guard so concurrent fibers (Bun) or RPC requests
-- (chrome-ext offscreen Worker) can't race on the registry. lsm-tree
-- itself is single-writer; this guard only protects the resource
-- map, not the underlying tables.
module Main (
    main,
    -- Smoke entrypoints (legacy, kept for the test-node-import driver)
    hs_lsm_smoke,
    hs_lsm_smoke_reopen,
    -- Session lifecycle
    hs_lsm_open_session,
    hs_lsm_close_session,
    -- Table lifecycle
    hs_lsm_open_table,
    hs_lsm_close_table,
    -- KV operations
    hs_lsm_get,
    hs_lsm_put,
    hs_lsm_delete,
    hs_lsm_has,
    -- Batch operations
    hs_lsm_put_batch,
    hs_lsm_delete_batch,
    -- Cursor operations
    hs_lsm_cursor_open,
    hs_lsm_cursor_read,
    hs_lsm_cursor_close,
    -- Snapshot operations
    hs_lsm_save_snapshot,
    hs_lsm_open_snapshot,
) where

import           Control.Concurrent.MVar (MVar, modifyMVar, modifyMVar_, newMVar,
                                          withMVar)
import           Control.Exception       (SomeException, displayException, try)
import qualified Data.ByteString         as BS
import qualified Data.ByteString.Unsafe  as BSU
import           Data.IntMap.Strict      (IntMap)
import qualified Data.IntMap.Strict      as IntMap
import qualified Data.Text               as Text
import qualified Data.Vector             as Vec
import           Data.Word               (Word32, Word8)
import           Foreign.C.String        (peekCStringLen)
import           Foreign.Marshal.Alloc   (mallocBytes)
import           Foreign.Marshal.Utils   (copyBytes)
import           Foreign.Ptr             (Ptr, castPtr, plusPtr)
import           Foreign.Storable        (peekByteOff, poke, pokeByteOff)
import           System.IO               (hPutStrLn, stderr)
import           System.IO.Unsafe        (unsafePerformIO)

import qualified Database.LSMTree.Simple as LSMT

-- ---------------------------------------------------------------------------
-- Resource registry
-- ---------------------------------------------------------------------------

-- | Every Haskell resource we hand to JS lives behind a `Word32`
-- handle. The registry maps `Word32 → Resource` via `IntMap`; the
-- counter is monotonically increasing so a freed handle is never
-- reissued within a single process lifetime (handles wrap at 2^32
-- after ~4 billion ops — practically never).
data Resource
  = RSession !LSMT.Session
  | RTable !(LSMT.Table BS.ByteString BS.ByteString)
  | RCursor !(LSMT.Cursor BS.ByteString BS.ByteString)

-- | Single global registry. `MVar` guards against interleaved
-- modification from Bun's fiber scheduler (which yields at every
-- `await` boundary inside the WASM module). On chrome-ext the
-- offscreen Worker pool size is 1, so contention is impossible —
-- the MVar is essentially free.
{-# NOINLINE registry #-}
registry :: MVar (IntMap Resource, Word32)
registry = unsafePerformIO (newMVar (IntMap.empty, 1))

-- | Insert a resource and return its freshly-minted handle. O(log n).
allocHandle :: Resource -> IO Word32
allocHandle r = modifyMVar registry $ \(m, !next) -> do
  let !m' = IntMap.insert (fromIntegral next) r m
  pure ((m', next + 1), next)

-- | Look up a `Session`, `Table`, or `Cursor` by handle. Returns
-- `Nothing` if the handle is unknown or refers to a resource of the
-- wrong kind.
lookupSession :: Word32 -> IO (Maybe LSMT.Session)
lookupSession h = withMVar registry $ \(m, _) ->
  pure $ case IntMap.lookup (fromIntegral h) m of
    Just (RSession s) -> Just s
    _                 -> Nothing

lookupTable :: Word32 -> IO (Maybe (LSMT.Table BS.ByteString BS.ByteString))
lookupTable h = withMVar registry $ \(m, _) ->
  pure $ case IntMap.lookup (fromIntegral h) m of
    Just (RTable t) -> Just t
    _               -> Nothing

lookupCursor :: Word32 -> IO (Maybe (LSMT.Cursor BS.ByteString BS.ByteString))
lookupCursor h = withMVar registry $ \(m, _) ->
  pure $ case IntMap.lookup (fromIntegral h) m of
    Just (RCursor c) -> Just c
    _                -> Nothing

-- | Drop a handle from the registry. Caller is responsible for any
-- resource cleanup (close the table / cursor / session) *before*
-- calling this; the registry just owns the reference.
releaseHandle :: Word32 -> IO ()
releaseHandle h = modifyMVar_ registry $ \(m, n) ->
  pure (IntMap.delete (fromIntegral h) m, n)

-- ---------------------------------------------------------------------------
-- Return-code convention
-- ---------------------------------------------------------------------------

-- | Every reactor returns a `Word32` status code:
--
--   * 0  — success
--   * 1  — "not found" / "empty cursor" (lookup miss, cursor exhausted)
--   * other — fault; a diagnostic line is written to stderr (fd 2),
--     which WASI routes onto `process.stderr` (Bun/Node) or
--     `console.error` (browser shim).
rcOk, rcMiss, rcFault, rcBadHandle :: Word32
rcOk        = 0
rcMiss      = 1
rcFault     = 2
rcBadHandle = 3

-- | Run an `IO ()` action, catch any exception, emit a diagnostic
-- line to stderr, and return the appropriate `Word32` status.
wrapVoid :: String -> IO () -> IO Word32
wrapVoid label action = do
  result <- try action
  case result of
    Right ()                  -> pure rcOk
    Left (e :: SomeException) -> do
      hPutStrLn stderr (label <> ": " <> displayException e)
      pure rcFault

-- | Like `wrapVoid` but for an action that returns a status code
-- directly (e.g. lookups that distinguish `Hit` from `Miss`). The
-- caller's action is responsible for returning `rcOk` / `rcMiss`.
wrapRc :: String -> IO Word32 -> IO Word32
wrapRc label action = do
  result <- try action
  case result of
    Right rc                  -> pure rc
    Left (e :: SomeException) -> do
      hPutStrLn stderr (label <> ": " <> displayException e)
      pure rcFault

-- ---------------------------------------------------------------------------
-- Pointer / buffer helpers
-- ---------------------------------------------------------------------------

-- | Read a `(ptr, len)` slice from WASM linear memory as a strict
-- `ByteString`. `BS.packCStringLen` copies, so the resulting
-- ByteString is independent of the caller's buffer lifecycle.
readBytes :: Ptr Word8 -> Word32 -> IO BS.ByteString
readBytes p n = BS.packCStringLen (castPtr p, fromIntegral n)

-- | Read a UTF-8 path/label from WASM linear memory.
readText :: Ptr Word8 -> Word32 -> IO String
readText p n = peekCStringLen (castPtr p, fromIntegral n)

-- | Write a list of `(key, value)` pairs into a freshly-malloc'd
-- buffer using the flat wire format:
--   [k_len:u32 LE][k][v_len:u32 LE][v]...
-- Returns the buffer pointer + total byte count. The JS caller is
-- responsible for `free`ing the buffer (the shim exports `free`).
writeEntries :: [(BS.ByteString, BS.ByteString)] -> IO (Ptr Word8, Int)
writeEntries entries = do
  let !totalSize = sum [4 + BS.length k + 4 + BS.length v | (k, v) <- entries]
  buf <- mallocBytes totalSize
  let go _   []          = pure ()
      go off ((k, v):xs) = do
        pokeByteOff buf off (fromIntegral (BS.length k) :: Word32)
        BSU.unsafeUseAsCStringLen k $ \(kp, kl) ->
          copyBytes (plusPtr buf (off + 4)) (castPtr kp) kl
        let !off2 = off + 4 + BS.length k
        pokeByteOff buf off2 (fromIntegral (BS.length v) :: Word32)
        BSU.unsafeUseAsCStringLen v $ \(vp, vl) ->
          copyBytes (plusPtr buf (off2 + 4)) (castPtr vp) vl
        go (off2 + 4 + BS.length v) xs
  go 0 entries
  pure (buf, totalSize)

-- | Decode the flat wire format used by `putBatch`/`deleteBatch`
-- input buffers. The `forKeyVal` flag distinguishes the two: `True`
-- consumes `[k][v]` pairs, `False` (`delete_batch`) consumes `[k]`
-- only.
decodeEntries :: Bool -> Ptr Word8 -> Word32 -> IO [(BS.ByteString, BS.ByteString)]
decodeEntries forKeyVal buf len = go 0
  where
    go off
      | off >= fromIntegral len = pure []
      | otherwise = do
          kLen <- peekByteOff @Word32 buf off
          key  <- BS.packCStringLen (castPtr (plusPtr buf (off + 4)), fromIntegral kLen)
          let !off2 = off + 4 + fromIntegral kLen
          if forKeyVal
            then do
              vLen <- peekByteOff @Word32 buf off2
              val  <- BS.packCStringLen (castPtr (plusPtr buf (off2 + 4)), fromIntegral vLen)
              rest <- go (off2 + 4 + fromIntegral vLen)
              pure ((key, val) : rest)
            else do
              rest <- go off2
              pure ((key, BS.empty) : rest)

-- ---------------------------------------------------------------------------
-- Session lifecycle
-- ---------------------------------------------------------------------------

-- | Open a session at the given directory.
--
-- Wire: `(pathPtr, pathLen, outHandlePtr)`. On success writes the
-- new session handle to `outHandlePtr` and returns 0.
hs_lsm_open_session :: Ptr Word8 -> Word32 -> Ptr Word32 -> IO Word32
hs_lsm_open_session pathPtr pathLen outHandle = wrapVoid "hs_lsm_open_session" $ do
  path <- readText pathPtr pathLen
  session <- LSMT.openSession path
  h <- allocHandle (RSession session)
  poke outHandle h

-- | Close a session by handle. Subsequent operations on the handle
-- (or any tables/cursors opened under it that aren't separately
-- closed) yield "bad handle" or undefined behaviour.
hs_lsm_close_session :: Word32 -> IO Word32
hs_lsm_close_session h = wrapRc "hs_lsm_close_session" $ do
  mSession <- lookupSession h
  case mSession of
    Nothing -> pure rcBadHandle
    Just s  -> do
      LSMT.closeSession s
      releaseHandle h
      pure rcOk

-- ---------------------------------------------------------------------------
-- Table lifecycle
-- ---------------------------------------------------------------------------

-- | Open a new table within an existing session. `labelPtr`/`labelLen`
-- are currently ignored (the simple API doesn't take a label at
-- open time — labels are only used at snapshot time). Reserved for
-- forward compatibility.
--
-- Wire: `(sessionHandle, labelPtr, labelLen, outHandlePtr)`.
hs_lsm_open_table :: Word32 -> Ptr Word8 -> Word32 -> Ptr Word32 -> IO Word32
hs_lsm_open_table sessionH _labelPtr _labelLen outHandle =
  wrapRc "hs_lsm_open_table" $ do
    mSession <- lookupSession sessionH
    case mSession of
      Nothing -> pure rcBadHandle
      Just session -> do
        table <- LSMT.newTable @BS.ByteString @BS.ByteString session
        h <- allocHandle (RTable table)
        poke outHandle h
        pure rcOk

-- | Close a table handle.
hs_lsm_close_table :: Word32 -> IO Word32
hs_lsm_close_table h = wrapRc "hs_lsm_close_table" $ do
  mTable <- lookupTable h
  case mTable of
    Nothing -> pure rcBadHandle
    Just t  -> do
      LSMT.closeTable t
      releaseHandle h
      pure rcOk

-- ---------------------------------------------------------------------------
-- KV operations
-- ---------------------------------------------------------------------------

-- | Look up a key. Single-phase malloc-and-return — the callee
-- allocates a buffer of exactly the right size and writes its
-- pointer + length to the out-pointers. The JS caller reads the
-- bytes via `memory.buffer` and then calls `free(bufPtr)`.
--
-- Wire: `(tableHandle, keyPtr, keyLen, outBufPtrPtr, outLenPtr)`.
-- Returns: `rcOk` (present, buffer written), `rcMiss` (key absent,
-- no buffer allocated), `rcBadHandle`, `rcFault`.
hs_lsm_get :: Word32 -> Ptr Word8 -> Word32 -> Ptr (Ptr Word8) -> Ptr Word32 -> IO Word32
hs_lsm_get tableH keyPtr keyLen outBufPtrPtr outLenPtr =
  wrapRc "hs_lsm_get" $ do
    mTable <- lookupTable tableH
    case mTable of
      Nothing -> pure rcBadHandle
      Just t -> do
        key <- readBytes keyPtr keyLen
        mVal <- LSMT.lookup t key
        case mVal of
          Nothing -> do
            poke outLenPtr 0
            pure rcMiss
          Just val -> do
            let !vlen = BS.length val
            buf <- mallocBytes vlen
            BSU.unsafeUseAsCStringLen val $ \(vp, vl) ->
              copyBytes buf (castPtr vp) vl
            poke outBufPtrPtr buf
            poke outLenPtr (fromIntegral vlen)
            pure rcOk

-- | Insert a key/value pair (upsert).
hs_lsm_put :: Word32 -> Ptr Word8 -> Word32 -> Ptr Word8 -> Word32 -> IO Word32
hs_lsm_put tableH keyPtr keyLen valPtr valLen = wrapVoid "hs_lsm_put" $ do
  mTable <- lookupTable tableH
  case mTable of
    Nothing -> error "hs_lsm_put: bad table handle"
    Just t -> do
      key <- readBytes keyPtr keyLen
      val <- readBytes valPtr valLen
      LSMT.insert t key val

-- | Delete a key.
hs_lsm_delete :: Word32 -> Ptr Word8 -> Word32 -> IO Word32
hs_lsm_delete tableH keyPtr keyLen = wrapVoid "hs_lsm_delete" $ do
  mTable <- lookupTable tableH
  case mTable of
    Nothing -> error "hs_lsm_delete: bad table handle"
    Just t -> do
      key <- readBytes keyPtr keyLen
      LSMT.delete t key

-- | Check key presence. Returns `rcOk` (present) / `rcMiss` (absent).
hs_lsm_has :: Word32 -> Ptr Word8 -> Word32 -> IO Word32
hs_lsm_has tableH keyPtr keyLen = wrapRc "hs_lsm_has" $ do
  mTable <- lookupTable tableH
  case mTable of
    Nothing -> pure rcBadHandle
    Just t -> do
      key <- readBytes keyPtr keyLen
      present <- LSMT.member t key
      pure (if present then rcOk else rcMiss)

-- ---------------------------------------------------------------------------
-- Batch operations
-- ---------------------------------------------------------------------------

-- | Insert a batch encoded as `[k_len:u32][k][v_len:u32][v]...`.
hs_lsm_put_batch :: Word32 -> Ptr Word8 -> Word32 -> IO Word32
hs_lsm_put_batch tableH bufPtr bufLen = wrapVoid "hs_lsm_put_batch" $ do
  mTable <- lookupTable tableH
  case mTable of
    Nothing -> error "hs_lsm_put_batch: bad table handle"
    Just t -> do
      entries <- decodeEntries True bufPtr bufLen
      LSMT.inserts t (Vec.fromList entries)

-- | Delete a batch of keys encoded as `[k_len:u32][k]...`.
hs_lsm_delete_batch :: Word32 -> Ptr Word8 -> Word32 -> IO Word32
hs_lsm_delete_batch tableH bufPtr bufLen = wrapVoid "hs_lsm_delete_batch" $ do
  mTable <- lookupTable tableH
  case mTable of
    Nothing -> error "hs_lsm_delete_batch: bad table handle"
    Just t -> do
      entries <- decodeEntries False bufPtr bufLen
      LSMT.deletes t (Vec.fromList (map fst entries))

-- ---------------------------------------------------------------------------
-- Cursor operations
-- ---------------------------------------------------------------------------

-- | Open a cursor on a table. If `prefixLen == 0`, the cursor starts
-- at the beginning; otherwise it starts at the offset key.
--
-- Wire: `(tableHandle, prefixPtr, prefixLen, outHandlePtr)`.
hs_lsm_cursor_open :: Word32 -> Ptr Word8 -> Word32 -> Ptr Word32 -> IO Word32
hs_lsm_cursor_open tableH prefixPtr prefixLen outHandle =
  wrapRc "hs_lsm_cursor_open" $ do
    mTable <- lookupTable tableH
    case mTable of
      Nothing -> pure rcBadHandle
      Just t -> do
        cursor <-
          if prefixLen == 0
            then LSMT.newCursor t
            else do
              prefix <- readBytes prefixPtr prefixLen
              LSMT.newCursorAtOffset t prefix
        h <- allocHandle (RCursor cursor)
        poke outHandle h
        pure rcOk

-- | Read up to `maxCount` entries from the cursor into a freshly-
-- malloc'd flat buffer. Single-phase: the callee allocates and
-- returns the buffer pointer + length + count via out-pointers. JS
-- copies the bytes then calls `free(bufPtr)`.
--
-- The cursor advances by exactly the returned count per call. There
-- is no inter-call state — a follow-up call with the same cursor
-- handle returns the next batch.
--
-- Wire: `(cursorHandle, maxCount, outBufPtrPtr, outLenPtr, outCountPtr)`.
-- Returns: rcOk on success (count > 0), rcMiss on exhausted cursor.
hs_lsm_cursor_read
  :: Word32             -- ^ cursor handle
  -> Word32             -- ^ max count
  -> Ptr (Ptr Word8)    -- ^ OUT: buffer pointer (malloc'd by callee)
  -> Ptr Word32         -- ^ OUT: total byte length
  -> Ptr Word32         -- ^ OUT: entry count
  -> IO Word32
hs_lsm_cursor_read cursorH maxCount outBufPtrPtr outLenPtr outCountPtr =
  wrapRc "hs_lsm_cursor_read" $ do
    mCursor <- lookupCursor cursorH
    case mCursor of
      Nothing -> pure rcBadHandle
      Just c -> do
        vec <- LSMT.take (fromIntegral maxCount) c
        let entries = Vec.toList vec
            !count = length entries
        if count == 0
          then do
            poke outLenPtr 0
            poke outCountPtr 0
            pure rcMiss
          else do
            (buf, totalSize) <- writeEntries entries
            poke outBufPtrPtr buf
            poke outLenPtr (fromIntegral totalSize)
            poke outCountPtr (fromIntegral count)
            pure rcOk

-- | Close a cursor.
hs_lsm_cursor_close :: Word32 -> IO Word32
hs_lsm_cursor_close h = wrapRc "hs_lsm_cursor_close" $ do
  mCursor <- lookupCursor h
  case mCursor of
    Nothing -> pure rcBadHandle
    Just c -> do
      LSMT.closeCursor c
      releaseHandle h
      pure rcOk

-- ---------------------------------------------------------------------------
-- Snapshot operations
-- ---------------------------------------------------------------------------

-- | Save the current table as a named snapshot.
-- Wire: `(tableHandle, namePtr, nameLen, labelPtr, labelLen)`.
hs_lsm_save_snapshot
  :: Word32 -> Ptr Word8 -> Word32 -> Ptr Word8 -> Word32 -> IO Word32
hs_lsm_save_snapshot tableH namePtr nameLen labelPtr labelLen =
  wrapVoid "hs_lsm_save_snapshot" $ do
    mTable <- lookupTable tableH
    case mTable of
      Nothing -> error "hs_lsm_save_snapshot: bad table handle"
      Just t -> do
        nameStr  <- readText namePtr nameLen
        labelStr <- readText labelPtr labelLen
        let !sn    = LSMT.toSnapshotName nameStr
            !label = LSMT.SnapshotLabel (Text.pack labelStr)
        LSMT.saveSnapshot sn label t

-- | Restore a table from a named snapshot. Allocates a new table
-- handle and writes it to `outHandlePtr`.
-- Wire: `(sessionHandle, namePtr, nameLen, labelPtr, labelLen, outHandlePtr)`.
hs_lsm_open_snapshot
  :: Word32 -> Ptr Word8 -> Word32 -> Ptr Word8 -> Word32 -> Ptr Word32 -> IO Word32
hs_lsm_open_snapshot sessionH namePtr nameLen labelPtr labelLen outHandle =
  wrapRc "hs_lsm_open_snapshot" $ do
    mSession <- lookupSession sessionH
    case mSession of
      Nothing -> pure rcBadHandle
      Just session -> do
        nameStr  <- readText namePtr nameLen
        labelStr <- readText labelPtr labelLen
        let !sn    = LSMT.toSnapshotName nameStr
            !label = LSMT.SnapshotLabel (Text.pack labelStr)
        table <-
          LSMT.openTableFromSnapshot
            @BS.ByteString @BS.ByteString session sn label
        h <- allocHandle (RTable table)
        poke outHandle h
        pure rcOk

-- ---------------------------------------------------------------------------
-- Legacy smoke entrypoints (kept for `test-node-import.mjs`)
-- ---------------------------------------------------------------------------

-- | `-no-hs-main` strips the runtime entry, but GHC still requires
-- the `Main` module to export an `IO ()` named `main`. It is never
-- called; the reactor exports below are the effective entrypoints.
main :: IO ()
main = pure ()

-- | End-to-end smoke that exercises the full lsm-tree → fs-api →
-- blockio → WASI Preview 1 → host filesystem path.
hs_lsm_smoke :: Ptr Word8 -> Word32 -> IO Word32
hs_lsm_smoke pathPtr pathLen = wrapVoid "hs_lsm_smoke" $ do
  path <- readText pathPtr pathLen
  LSMT.withOpenSession path $ \session ->
    LSMT.withTable session $ \(table :: LSMT.Table BS.ByteString BS.ByteString) -> do
      LSMT.insert table "key1" "value1"
      LSMT.insert table "key2" "value2"
      v1 <- LSMT.lookup table "key1"
      v2 <- LSMT.lookup table "key2"
      vMissing <- LSMT.lookup table "key3"
      ensure "lookup key1" (v1 == Just "value1") (show v1)
      ensure "lookup key2" (v2 == Just "value2") (show v2)
      ensure "lookup key3 (missing)" (vMissing == Nothing) (show vMissing)

-- | Snapshot persistence smoke. Demonstrates that lsm-tree's
-- snapshot files survive a process-equivalent close+reopen cycle.
hs_lsm_smoke_reopen :: Ptr Word8 -> Word32 -> IO Word32
hs_lsm_smoke_reopen pathPtr pathLen = wrapVoid "hs_lsm_smoke_reopen" $ do
  path <- readText pathPtr pathLen
  let !snapName  = LSMT.toSnapshotName "wasm-smoke"
      !snapLabel = LSMT.SnapshotLabel "lsm-wasm-shim-bytestring-table-v1"
  LSMT.withOpenSession path $ \session ->
    LSMT.withTable session $ \(table :: LSMT.Table BS.ByteString BS.ByteString) -> do
      LSMT.insert table "persistent-key-a" "persistent-value-a"
      LSMT.insert table "persistent-key-b" "persistent-value-b"
      LSMT.saveSnapshot snapName snapLabel table

ensure :: String -> Bool -> String -> IO ()
ensure label ok detail
  | ok        = pure ()
  | otherwise = ioError (userError (label <> ": unexpected " <> detail))

-- ---------------------------------------------------------------------------
-- Foreign export declarations
-- ---------------------------------------------------------------------------

foreign export javascript "hs_lsm_smoke sync"
  hs_lsm_smoke :: Ptr Word8 -> Word32 -> IO Word32

foreign export javascript "hs_lsm_smoke_reopen sync"
  hs_lsm_smoke_reopen :: Ptr Word8 -> Word32 -> IO Word32

foreign export javascript "hs_lsm_open_session sync"
  hs_lsm_open_session :: Ptr Word8 -> Word32 -> Ptr Word32 -> IO Word32

foreign export javascript "hs_lsm_close_session sync"
  hs_lsm_close_session :: Word32 -> IO Word32

foreign export javascript "hs_lsm_open_table sync"
  hs_lsm_open_table :: Word32 -> Ptr Word8 -> Word32 -> Ptr Word32 -> IO Word32

foreign export javascript "hs_lsm_close_table sync"
  hs_lsm_close_table :: Word32 -> IO Word32

foreign export javascript "hs_lsm_get sync"
  hs_lsm_get :: Word32 -> Ptr Word8 -> Word32 -> Ptr (Ptr Word8) -> Ptr Word32 -> IO Word32

foreign export javascript "hs_lsm_put sync"
  hs_lsm_put :: Word32 -> Ptr Word8 -> Word32 -> Ptr Word8 -> Word32 -> IO Word32

foreign export javascript "hs_lsm_delete sync"
  hs_lsm_delete :: Word32 -> Ptr Word8 -> Word32 -> IO Word32

foreign export javascript "hs_lsm_has sync"
  hs_lsm_has :: Word32 -> Ptr Word8 -> Word32 -> IO Word32

foreign export javascript "hs_lsm_put_batch sync"
  hs_lsm_put_batch :: Word32 -> Ptr Word8 -> Word32 -> IO Word32

foreign export javascript "hs_lsm_delete_batch sync"
  hs_lsm_delete_batch :: Word32 -> Ptr Word8 -> Word32 -> IO Word32

foreign export javascript "hs_lsm_cursor_open sync"
  hs_lsm_cursor_open :: Word32 -> Ptr Word8 -> Word32 -> Ptr Word32 -> IO Word32

foreign export javascript "hs_lsm_cursor_read sync"
  hs_lsm_cursor_read
    :: Word32 -> Word32 -> Ptr (Ptr Word8) -> Ptr Word32 -> Ptr Word32 -> IO Word32

foreign export javascript "hs_lsm_cursor_close sync"
  hs_lsm_cursor_close :: Word32 -> IO Word32

foreign export javascript "hs_lsm_save_snapshot sync"
  hs_lsm_save_snapshot
    :: Word32 -> Ptr Word8 -> Word32 -> Ptr Word8 -> Word32 -> IO Word32

foreign export javascript "hs_lsm_open_snapshot sync"
  hs_lsm_open_snapshot
    :: Word32 -> Ptr Word8 -> Word32 -> Ptr Word8 -> Word32 -> Ptr Word32 -> IO Word32
