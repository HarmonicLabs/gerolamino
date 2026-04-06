{-# LANGUAGE ForeignFunctionInterface #-}
{-# LANGUAGE OverloadedStrings #-}

-- | C-callable FFI wrapper for lsm-tree.
--
-- Exposes session, table, and KV operations as C functions
-- callable from Bun FFI (or any C-compatible caller).
--
-- Memory convention:
--   Keys/values: (Ptr Word8, CSize) — caller owns memory, callee copies.
--   Handles: opaque StablePtr — caller must close when done.
module LsmFFI where

import Foreign
import Foreign.C.Types
import Foreign.C.String
import Foreign.StablePtr
import Foreign.Marshal.Alloc (mallocBytes)
import Foreign.Marshal.Utils (copyBytes)
import qualified Data.ByteString as BS
import qualified Data.ByteString.Unsafe as BSU
import qualified Database.LSMTree.Simple as LSM
import System.IO (hPutStrLn, stderr)
import Control.Exception (try, SomeException, displayException)
import qualified Data.Vector as Data.Vector

type SessionHandle = StablePtr LSM.Session
type TableHandle   = StablePtr (LSM.Table BS.ByteString BS.ByteString)

-- Session lifecycle --------------------------------------------------------

foreign export ccall lsm_session_open :: CString -> Ptr SessionHandle -> IO CInt
lsm_session_open :: CString -> Ptr SessionHandle -> IO CInt
lsm_session_open pathPtr outPtr = wrap "session_open" $ do
  path <- peekCString pathPtr
  session <- LSM.openSession path
  sp <- newStablePtr session
  poke outPtr sp

foreign export ccall lsm_session_close :: SessionHandle -> IO CInt
lsm_session_close :: SessionHandle -> IO CInt
lsm_session_close sp = wrap "session_close" $ do
  session <- deRefStablePtr sp
  LSM.closeSession session
  freeStablePtr sp

-- Table lifecycle ----------------------------------------------------------

foreign export ccall lsm_table_new :: SessionHandle -> Ptr TableHandle -> IO CInt
lsm_table_new :: SessionHandle -> Ptr TableHandle -> IO CInt
lsm_table_new sessionSp outPtr = wrap "table_new" $ do
  session <- deRefStablePtr sessionSp
  table <- LSM.newTable session
  sp <- newStablePtr table
  poke outPtr sp

foreign export ccall lsm_table_close :: TableHandle -> IO CInt
lsm_table_close :: TableHandle -> IO CInt
lsm_table_close sp = wrap "table_close" $ do
  table <- deRefStablePtr sp
  LSM.closeTable table
  freeStablePtr sp

-- KV operations ------------------------------------------------------------

foreign export ccall lsm_insert
  :: TableHandle -> Ptr Word8 -> CSize -> Ptr Word8 -> CSize -> IO CInt
lsm_insert :: TableHandle -> Ptr Word8 -> CSize -> Ptr Word8 -> CSize -> IO CInt
lsm_insert tableSp keyPtr keyLen valPtr valLen = wrap "insert" $ do
  table <- deRefStablePtr tableSp
  key <- BS.packCStringLen (castPtr keyPtr, fromIntegral keyLen)
  val <- BS.packCStringLen (castPtr valPtr, fromIntegral valLen)
  LSM.insert table key val

-- Returns 0=found, 1=not found, -1=error.
foreign export ccall lsm_lookup
  :: TableHandle -> Ptr Word8 -> CSize -> Ptr (Ptr Word8) -> Ptr CSize -> IO CInt
lsm_lookup :: TableHandle -> Ptr Word8 -> CSize -> Ptr (Ptr Word8) -> Ptr CSize -> IO CInt
lsm_lookup tableSp keyPtr keyLen outBufPtr outLenPtr = do
  table <- deRefStablePtr tableSp
  key <- BS.packCStringLen (castPtr keyPtr, fromIntegral keyLen)
  result <- try $ LSM.lookup table key
  case result of
    Left (e :: SomeException) -> do
      hPutStrLn stderr $ "lsm_lookup: " ++ displayException e
      return (-1)
    Right Nothing -> return 1
    Right (Just val) -> do
      BSU.unsafeUseAsCStringLen val $ \(vPtr, vLen) -> do
        poke outBufPtr (castPtr vPtr)
        poke outLenPtr (fromIntegral vLen)
      return 0

foreign export ccall lsm_delete
  :: TableHandle -> Ptr Word8 -> CSize -> IO CInt
lsm_delete :: TableHandle -> Ptr Word8 -> CSize -> IO CInt
lsm_delete tableSp keyPtr keyLen = wrap "delete" $ do
  table <- deRefStablePtr tableSp
  key <- BS.packCStringLen (castPtr keyPtr, fromIntegral keyLen)
  LSM.delete table key

-- Range lookup (for prefix scan) -------------------------------------------

-- | Range lookup: all entries with key in [lo, hi).
-- Returns count of entries written. Caller provides callback for each entry.
-- For simplicity, we return all results as a flat buffer:
--   [count:u32][key1_len:u32][key1][val1_len:u32][val1][key2_len:u32]...
-- Returns 0 on success, -1 on error. Count written to outCount.
foreign export ccall lsm_range_lookup
  :: TableHandle -> Ptr Word8 -> CSize -> Ptr Word8 -> CSize
  -> Ptr (Ptr Word8) -> Ptr CSize -> Ptr CSize -> IO CInt
lsm_range_lookup :: TableHandle -> Ptr Word8 -> CSize -> Ptr Word8 -> CSize
  -> Ptr (Ptr Word8) -> Ptr CSize -> Ptr CSize -> IO CInt
lsm_range_lookup tableSp loPtr loLen hiPtr hiLen outBufPtr outBufLen outCount = do
  table <- deRefStablePtr tableSp
  lo <- BS.packCStringLen (castPtr loPtr, fromIntegral loLen)
  hi <- BS.packCStringLen (castPtr hiPtr, fromIntegral hiLen)
  result <- try $ LSM.rangeLookup table (LSM.FromToExcluding lo hi)
  case result of
    Left (e :: SomeException) -> do
      hPutStrLn stderr $ "lsm_range_lookup: " ++ displayException e
      return (-1)
    Right vec -> do
      let entries = Data.Vector.toList vec
          totalSize = sum [4 + BS.length k + 4 + BS.length v | (k, v) <- entries]
          count = length entries
      buf <- mallocBytes totalSize
      let go _ [] = return ()
          go off ((k, v):rest) = do
            pokeByteOff buf off (fromIntegral (BS.length k) :: Word32)
            BSU.unsafeUseAsCStringLen k $ \(kp, kl) ->
              copyBytes (plusPtr buf (off + 4)) kp kl
            let off2 = off + 4 + BS.length k
            pokeByteOff buf off2 (fromIntegral (BS.length v) :: Word32)
            BSU.unsafeUseAsCStringLen v $ \(vp, vl) ->
              copyBytes (plusPtr buf (off2 + 4)) vp vl
            go (off2 + 4 + BS.length v) rest
      go 0 entries
      poke outBufPtr (castPtr buf)
      poke outBufLen (fromIntegral totalSize)
      poke outCount (fromIntegral count)
      return 0

-- Snapshot -----------------------------------------------------------------

foreign export ccall lsm_snapshot_save
  :: SessionHandle -> TableHandle -> CString -> IO CInt
lsm_snapshot_save :: SessionHandle -> TableHandle -> CString -> IO CInt
lsm_snapshot_save _sessionSp tableSp namePtr = wrap "snapshot_save" $ do
  table <- deRefStablePtr tableSp
  name <- peekCString namePtr
  let sn = LSM.toSnapshotName name
  LSM.saveSnapshot sn (LSM.SnapshotLabel "lsm-ffi") table

-- Helpers ------------------------------------------------------------------

wrap :: String -> IO () -> IO CInt
wrap label action = do
  result <- try action
  case result of
    Left (e :: SomeException) -> do
      hPutStrLn stderr $ "lsm_" ++ label ++ ": " ++ displayException e
      return (-1)
    Right () -> return 0
