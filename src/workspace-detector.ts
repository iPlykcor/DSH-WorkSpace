/**
 * Model-write detection for read-only workspace roots (强度 A v1): scans a
 * session's append-only event log with the SAME write/edit mapping the
 * changes-tab session lens uses (src/client/changes/ops.ts — constants kept
 * in lockstep, see its doc), resolves each candidate path canonically
 * (nearest-existing-ancestor walk so a just-deleted file still classifies),
 * and keeps the operations that landed inside a `readOnly` root AFTER the
 * workspace was activated. Rollback is best-effort and user-invoked: a write
 * restores the last content the log saw before the intrusion; an edit
 * reverse-applies its payload (first occurrence); otherwise the caller is
 * pointed at the file for review. The host has no snapshot layer, so a write
 * with no prior content in the window cannot be auto-restored.
 */
import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { SidebarSessionEvent } from './context-types.ts'
import { classifyWsPath, type ActiveWorkspace } from './workspace-policy.ts'
import { resolveSessionPath } from './session-path.ts'

/** Write/edit tool names whose calls may modify read-only roots. */
const WRITE_TOOLS = new Set(['write', 'create'])
const EDIT_TOOLS = new Set(['edit', 'str_replace', 'str-replace-editor', 'multi-edit'])

/** How many trailing events one scan folds (mirror of the changes.ops cap). */
const SCAN_EVENT_CAP = 4000

/** Cap of returned violations (newest kept). */
const VIOLATION_CAP = 200

/** One detected intrusion into a read-only root. */
export interface WsViolation {
  /** The originating tool-call id (stable identity, rollback key). */
  callId: string
  kind: 'write' | 'edit'
  /** Absolute display path of the written file (lexical). */
  path: string
  /** Label of the read-only root it landed in. */
  rootLabel: string
  /** Unix epoch ms of the call. */
  time: number
  /** Whether a best-effort auto-restore is possible. */
  canRestore: boolean
}

/** One folded write/edit call (port of changes/ops.ts extractFileOps subset). */
interface WsOp {
  callId: string
  kind: 'write' | 'edit'
  /** Raw path exactly as the model spelled it (relative to cwd usually). */
  rawPath: string
  time: number
  running: boolean
  isError: boolean
  /** write payload. */
  content?: string
  /** edit payload. */
  edit?: { oldString: string; newString: string }
}

/** Defensive JSON parse of a tool-call arguments string. */
function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Path field common to the write/edit tools. */
function pathOf(args: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'filePath']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** Fold the event window into write/edit ops (newest-last internal order). */
function foldWriteOps(events: readonly SidebarSessionEvent[]): WsOp[] {
  const byCall = new Map<string, WsOp>()
  let scanned = 0
  for (const event of events) {
    if (scanned >= SCAN_EVENT_CAP) break
    scanned += 1
    if (event.type === 'tool/call') {
      const data = event.data as { name?: unknown; callId?: unknown; arguments?: unknown }
      if (typeof data.name !== 'string' || typeof data.callId !== 'string') continue
      let kind: 'write' | 'edit' | undefined
      if (WRITE_TOOLS.has(data.name)) kind = 'write'
      else if (EDIT_TOOLS.has(data.name)) kind = 'edit'
      if (kind === undefined) continue
      const args = parseArgs(data.arguments)
      const rawPath = pathOf(args)
      if (rawPath === undefined) continue
      const op: WsOp = { callId: data.callId, kind, rawPath, time: event.time, running: true, isError: false }
      if (kind === 'write' && typeof args.content === 'string') op.content = args.content
      if (kind === 'edit' && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
        op.edit = { oldString: args.old_string, newString: args.new_string }
      }
      byCall.set(data.callId, op)
    } else if (event.type === 'tool/result') {
      const message = (event.data as { message?: unknown }).message as
        | { source?: { kind?: unknown; callId?: unknown }; content?: unknown }
        | undefined
      if (message === undefined) continue
      const callId = message.source?.callId
      if (typeof callId !== 'string') continue
      const op = byCall.get(callId)
      if (op === undefined) continue
      const error = Array.isArray(message.content)
        && message.content.some((block) => block !== null && typeof block === 'object'
          && (block as { type?: unknown; isError?: unknown }).type === 'tool-result'
          && (block as { type?: unknown; isError?: unknown }).isError === true)
      byCall.set(callId, { ...op, running: false, isError: error === true })
    }
  }
  return [...byCall.values()]
}

/** Canonicalize an absolute path for comparison: existing target realpath'd,
 *  missing target rebuilt onto its nearest existing canonical ancestor. */
async function canonicalForCompare(absolute: string): Promise<string> {
  let existing = absolute
  const missing: string[] = []
  for (;;) {
    try {
      return missing.reduce((path, segment) => join(path, segment), await realpath(existing))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return absolute
      const parent = dirname(existing)
      if (parent === existing) return absolute
      missing.unshift(existing.slice(parent.length + 1))
      existing = parent
    }
  }
}

/** Resolve an op's raw path to an absolute display path (session namespace). */
function absoluteOf(cwd: string, raw: string): string {
  if (isAbsolute(raw)) return resolveSessionPath(cwd, raw)
  return resolveSessionPath(cwd, join(cwd, raw))
}

/**
 * Scan a session's events for model writes into read-only roots of an active
 * workspace. Newest first, capped. Runs async (realpath per candidate).
 */
export async function scanWsViolations(
  workspace: ActiveWorkspace,
  cwd: string,
  events: readonly SidebarSessionEvent[],
): Promise<WsViolation[]> {
  const ops = foldWriteOps(events).filter(op => !op.running && !op.isError)
  const violations: WsViolation[] = []
  for (const op of ops) {
    if (op.time < workspace.activatedAt) continue
    const absolute = absoluteOf(cwd, op.rawPath)
    const canonical = await canonicalForCompare(absolute)
    const match = classifyWsPath(workspace, canonical)
    if (match === undefined || match.root.access !== 'readOnly') continue
    const prior = priorContentOf(ops, op.rawPath, op.time)
    const canRestore = op.kind === 'edit' && op.edit !== undefined
      ? true
      : op.kind === 'write' && op.content !== undefined && prior !== undefined
    violations.push({
      callId: op.callId,
      kind: op.kind,
      path: absolute,
      rootLabel: match.root.label,
      time: op.time,
      canRestore,
    })
  }
  violations.sort((a, b) => b.time - a.time)
  return violations.slice(0, VIOLATION_CAP)
}

/** Last content the log saw for `rawPath` before `before` (writes are
 *  authoritative; an immediately preceding edit only implies its old side,
 *  which is not a full file image — so only write payloads count here). */
function priorContentOf(ops: readonly WsOp[], rawPath: string, before: number): string | undefined {
  let last: string | undefined
  for (const op of ops) {
    if (op.rawPath !== rawPath || op.time >= before) continue
    if (op.kind === 'write' && op.content !== undefined) last = op.content
  }
  return last
}

/**
 * Best-effort user-invoked restore of one violation. Resolves success or a
 * human message; writes are atomic (temp sibling + rename).
 */
export async function rollbackWsViolation(
  workspace: ActiveWorkspace,
  cwd: string,
  events: readonly SidebarSessionEvent[],
  callId: string,
): Promise<{ ok: boolean; message: string }> {
  const op = foldWriteOps(events).find(candidate => candidate.callId === callId && !candidate.running && !candidate.isError)
  if (op === undefined) return { ok: false, message: 'no settled write/edit with that id in the event log' }
  const absolute = absoluteOf(cwd, op.rawPath)
  const canonical = await canonicalForCompare(absolute)
  const match = classifyWsPath(workspace, canonical)
  if (match === undefined || match.root.access !== 'readOnly') {
    return { ok: false, message: 'operation did not target a read-only workspace folder' }
  }
  try {
    if (op.kind === 'edit' && op.edit !== undefined) {
      const current = await readFile(canonical, 'utf8')
      const index = current.indexOf(op.edit.newString)
      if (index === -1) return { ok: false, message: 'file changed since the edit; open it for manual review' }
      const restored = current.slice(0, index) + op.edit.oldString + current.slice(index + op.edit.newString.length)
      await writeAtomic(canonical, restored)
      return { ok: true, message: `restored edit on "${absolute}"` }
    }
    if (op.kind === 'write' && op.content !== undefined) {
      const prior = priorContentOf(foldWriteOps(events), op.rawPath, op.time)
      if (prior === undefined) return { ok: false, message: 'no earlier content in this session log; open the file for manual review' }
      await writeAtomic(canonical, prior)
      return { ok: true, message: `restored previous content of "${absolute}"` }
    }
  } catch (error) {
    return { ok: false, message: `restore failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: false, message: 'nothing restorable for this operation' }
}

/** Atomic utf8 write (temp sibling + rename), matching the fs.write route. */
async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.dshws-restore-${process.pid}`
  try {
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}
