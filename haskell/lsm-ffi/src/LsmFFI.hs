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
import qualified Data.ByteString as BS
import qualified Data.ByteString.Unsafe as BSU
import qualified Database.LSMTree.Simple as LSM
import System.IO (hPutStrLn, stderr)
import Control.Exception (try, SomeException, displayException)

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
