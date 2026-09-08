/**
 * The archive "folder listing" viewer: lists a zip / 7z / rar archive's
 * entries as a navigable tree — folders expand/collapse, files are shown as
 * read-only rows (their name includes the extension, i.e. the type). The
 * format is sniffed from the magic bytes (see archive-format.ts), so the same
 * viewer serves zip (fflate), 7z (7z-wasm) and rar (node-unrar-js).
 *
 * File-content preview is intentionally disabled: the goal is to browse the
 * file list and types, not to decompress + render individual entries (arbitrary
 * or encrypted entries / large renders can error or crash the view). Used by
 * both the sidebar editor and the center "Files" view.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { loadChunk } from './chunk-loader.ts'
import { blobUrl, type SessionScope } from './api.ts'
import { archiveFormatOf } from './archive-format.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'
import type { ArchiveRenderFn, ZipArchive, ZipRenderFn } from './zip-types.ts'

interface Row { name: string; path: string; dir: boolean }

export interface ZipViewProps { scope: SessionScope; path: string; customData?: unknown; title?: string }

export function ZipView({ scope, path, customData }: ZipViewProps): ReactNode {
  const [archive, setArchive] = useState<ZipArchive | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Load the archive bytes (fetch when the caller didn't pass customData).
  useEffect(() => {
    let cancelled = false
    setArchive(null); setExpanded(new Set()); setError(null)
    void (async () => {
      try {
        const bytes = customData === undefined ? await fetchBytes(scope, path) : (customData as ArrayBuffer)
        const parsed = await readArchive(bytes)
        if (cancelled) return
        setArchive(parsed)
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure))
      }
    })()
    return () => { cancelled = true }
  }, [scope.sessionId, scope.cwd, path, customData])

  const childrenOf = useCallback((dir: string): Row[] => {
    if (archive === null) return []
    const prefix = dir === '' ? '' : `${dir}/`
    const map = new Map<string, Row>()
    for (const d of archive.dirs) {
      if (d.startsWith(prefix) && d !== dir) {
        const rest = d.slice(prefix.length)
        if (rest !== '' && !rest.includes('/')) map.set(rest, { name: rest, path: d, dir: true })
      }
    }
    for (const p of archive.files.keys()) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      if (rest === '') continue
      if (rest.includes('/')) {
        const d = rest.split('/')[0] ?? ''
        if (!map.has(d)) map.set(d, { name: d, path: `${prefix}${d}`, dir: true })
      } else {
        map.set(rest, { name: rest, path: p, dir: false })
      }
    }
    return [...map.values()].sort((a, b) => a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1)
  }, [archive])

  const toggle = (dir: string): void => {
    setExpanded(prev => { const next = new Set(prev); if (next.has(dir)) next.delete(dir); else next.add(dir); return next })
  }

  const renderTree = (dir: string, depth: number): ReactNode => {
    if (archive === null) return null
    const rows = childrenOf(dir)
    return rows.map((row) => {
      const pad = { paddingLeft: depth * 18 + 8 }
      if (row.dir) {
        const open = expanded.has(row.path)
        return (
          <div key={`d:${row.path}`}>
            <div data-dsw-row role="button" tabIndex={0} style={{ ...pad, display: 'flex', alignItems: 'center', gap: 6, height: 24, cursor: 'pointer' }}
              onClick={() => toggle(row.path)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(row.path) }}>
              <span style={{ fontSize: 10, width: 10 }}>{open ? '▼' : '▶'}</span>
              <span>{row.name}</span>
            </div>
            {open && renderTree(row.path, depth + 1)}
          </div>
        )
      }
      return (
        // File rows are read-only: no click/preview — only the name + type.
        <div key={`f:${row.path}`} data-dsw-row style={{ ...pad, display: 'flex', alignItems: 'center', gap: 6, height: 24 }}>
          <span style={{ fontSize: 10, width: 10 }}>·</span>
          <span>{row.name}</span>
        </div>
      )
    })
  }

  return (
    <div className={css.centerFileEditor} style={{ overflow: 'visible' }}>
      <div className={css.editorHeader} style={{ position: 'sticky', top: 0, zIndex: 5, background: 'var(--dsw-alias-bg-layer-1)' }}>
        <span style={{ fontWeight: 600 }}>{baseName(path)}</span>
      </div>
      {error !== null && <div className={css.editorError} role="alert">{error}</div>}
      <div className={css.editorBody}>
        <div className={css.editorMain}>
          {archive === null ? <div className={css.editorPlaceholder}>{t('loading')}</div> : (
            <div style={{ overflow: 'auto', height: '100%' }}>{renderTree('', 0)}</div>
          )}
        </div>
      </div>
    </div>
  )
}

function baseName(p: string): string { const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return at === -1 ? p : p.slice(at + 1) }
async function fetchBytes(scope: SessionScope, path: string): Promise<ArrayBuffer> {
  const res = await fetch(blobUrl(scope, path))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.arrayBuffer()
}

/**
 * Read an archive by its detected format (zip → fflate via the `zip` chunk;
 * 7z / rar → the heavy `archive` chunk). Unknown magic falls back to zip, so
 * a genuinely malformed file surfaces the zip reader's own error rather than
 * a "no reader" message.
 */
async function readArchive(bytes: ArrayBuffer | Uint8Array): Promise<ZipArchive> {
  const format = archiveFormatOf(bytes) ?? 'zip'
  if (format === '7z' || format === 'rar') {
    const mod = await loadChunk('archive') as unknown as ArchiveRenderFn
    return format === '7z' ? mod.read7z(bytes) : mod.readRar(bytes)
  }
  const mod = await loadChunk('zip') as unknown as ZipRenderFn
  return mod.readZip(bytes)
}

// Re-export the ZipArchive/readZip types so the `zip` chunk consumers (and the
// caller) stay type-safe.
export type { ZipArchive }
