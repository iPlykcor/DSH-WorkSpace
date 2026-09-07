/**
 * Office preview extension classification (new formats only). Shared by the
 * `OfficeView` component and the center-column "Files" view so a file's
 * extension maps to the right office renderer (docx / spreadsheet /
 * presentation) regardless of the surface that opens it.
 */
export const OFFICE_VIEWER_BY_EXT: Record<string, string> = {
  docx: 'docx',
  xlsx: 'spreadsheet',
  pptx: 'presentation',
}

/** Whether `ext` (lowercase, no dot) is a built-in office preview extension. */
export function isOfficeExt(ext: string): boolean {
  return ext in OFFICE_VIEWER_BY_EXT
}

/** The office viewer id for an extension, or undefined when not an office ext. */
export function officeViewerIdForExt(ext: string): string | undefined {
  return OFFICE_VIEWER_BY_EXT[ext]
}

/** The office viewer id for a path (by its lowercase extension), or undefined. */
export function officeViewerIdForPath(path: string): string | undefined {
  const at = path.lastIndexOf('.')
  if (at === -1) return undefined
  return officeViewerIdForExt(path.slice(at + 1).toLowerCase())
}

/** The built-in office viewer ids (used to gate the center view). */
export const OFFICE_VIEWER_IDS = ['docx', 'spreadsheet', 'presentation']
