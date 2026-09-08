/**
 * Type-only surface of the lazy `zip` chunk, shared by the core `ZipView`
 * component. The core bundle must not statically import the chunk entry, so
 * these shapes are mirrored here (structural — the chunk's runtime exports
 * match them). `readZip` reads an archive; `textOf` decodes a UTF-8 entry.
 */
export interface ZipArchive {
  files: Map<string, Uint8Array>
  dirs: Set<string>
}

export interface ZipRenderFn {
  readZip(bytes: ArrayBuffer | Uint8Array): ZipArchive
  textOf(data: Uint8Array): string
  extOfPath(path: string): string
}

/** Type-only surface of the lazy `archive` chunk (7z / rar readers). The
 *  readers return the same {@link ZipArchive} shape as the zip reader, so the
 *  core {@link ZipView} can treat every format identically. */
export interface ArchiveRenderFn {
  read7z(bytes: ArrayBuffer | Uint8Array): Promise<ZipArchive>
  readRar(bytes: ArrayBuffer | Uint8Array): Promise<ZipArchive>
}
