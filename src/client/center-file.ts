/**
 * Per-session "file shown in the center-conversation view" registry.
 * The sidebar's file-open path writes here; the `dshws-file` conversation.view
 * (CenterFileView) subscribes and renders it. Module-level (one per client
 * bundle), not persisted — the center view is a transient surface.
 */
type Listener = () => void

const files = new Map<string, string>()
const listeners = new Set<Listener>()

/** Set (or clear) the file a session's center view shows. */
export function setCenterFile(sessionId: string, path: string | null): void {
  const next = path ?? ''
  if (files.get(sessionId) === next) return
  if (next === '') files.delete(sessionId)
  else files.set(sessionId, next)
  for (const listener of [...listeners]) listener()
}

/** The file a session's center view currently shows ('' = none). */
export function getCenterFile(sessionId: string): string {
  return files.get(sessionId) ?? ''
}

/** Subscribe to center-file changes. */
export function subscribeCenterFile(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
