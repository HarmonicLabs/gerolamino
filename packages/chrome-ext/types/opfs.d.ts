// OPFS Access Handles API + File System Access drag-and-drop —
// augmentation of the standard DOM types for surfaces shipping in
// Chromium but not yet in TypeScript's lib.dom typings.
//
// Spec references:
//   - https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle
//   - https://wicg.github.io/file-system-access/#dom-datatransferitem-getasfilesystemhandle

interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBuffer | ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBuffer | ArrayBufferView, options?: { at?: number }): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}

interface DataTransferItem {
  /** Chromium 86+; returns null for `kind === "string"` items. */
  getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
}
