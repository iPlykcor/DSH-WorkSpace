/**
 * The lazy `office` chunk: the docx/xlsx/pptx renderers, fetched by the editor
 * or the center "Files" view on first open of an office file (see
 * chunk-loader.ts). The core bundle never statically imports this entry.
 *
 * Renderers (all plain-DOM — no React mount inside the chunk):
 * - docx → `docx-preview` (MIT) — close-to-Word DOM rendering.
 * - xlsx → SheetJS (`xlsx`, Apache-2.0) into a bordered table (merged cells
 *   via colspan/rowspan) — a read-only, reliable preview.
 * - pptx → `@aiden0z/pptx-renderer` (Apache-2.0) — DOM/SVG slide renderer.
 *
 * Every render function takes the raw file bytes + a container element and
 * returns an optional disposer (null on abort/teardown).
 */
import { renderAsync } from 'docx-preview'
import * as XLSX from 'xlsx'
// The `/browser` entry is the browser-only build (no pdfjs/node shims) — the
// package's default entry drags `pdfjs-dist` (node:stream/fs) and trips the
// client-bundle purity gate.
import { PptxViewer } from '@aiden0z/pptx-renderer/browser'

/** One render call: bytes → container, optional cleanup. */
export type OfficeRender = (
  bytes: ArrayBuffer,
  container: HTMLElement,
  signal?: AbortSignal,
) => Promise<(() => void) | void>

export async function renderDocx(
  bytes: ArrayBuffer,
  container: HTMLElement,
  _signal?: AbortSignal,
): Promise<() => void> {
  await renderAsync(bytes, container, undefined, { inWrapper: true })
  return () => { container.replaceChildren() }
}

/** Build a bordered HTML table from one SheetJS worksheet (merged cells honored). */
function buildSheetTable(ws: XLSX.WorkSheet): HTMLTableElement {
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) as unknown[][]
  const merges = (ws['!merges'] ?? []) as Array<{ s: { r: number; c: number }; e: { r: number; c: number } }>

  // Compute the rectangular extent (rows/cols) from data + merges.
  let maxRow = 0
  let maxCol = 0
  aoa.forEach((row, r) => {
    if (r > maxRow) maxRow = r
    if (row.length > 0) { const c = row.length - 1; if (c > maxCol) maxCol = c }
  })
  for (const m of merges) {
    if (m.e.r > maxRow) maxRow = m.e.r
    if (m.e.c > maxCol) maxCol = m.e.c
  }

  // Cells covered by a merge but not the top-left — skipped during layout.
  const covered = new Set<string>()
  for (const m of merges) {
    for (let r = m.s.r; r <= m.e.r; r += 1) {
      for (let c = m.s.c; c <= m.e.c; c += 1) {
        if (r === m.s.r && c === m.s.c) continue
        covered.add(`${r}:${c}`)
      }
    }
  }
  const mergeAt = (r: number, c: number): { colspan: number; rowspan: number } | undefined => {
    const m = merges.find((mm) => mm.s.r === r && mm.s.c === c)
    return m === undefined ? undefined : { colspan: m.e.c - m.s.c + 1, rowspan: m.e.r - m.s.r + 1 }
  }

  const table = document.createElement('table')
  table.style.borderCollapse = 'collapse'
  table.style.fontSize = '13px'
  table.style.border = '1px solid #d6d6d6'
  const tbody = document.createElement('tbody')
  for (let r = 0; r <= maxRow; r += 1) {
    const tr = document.createElement('tr')
    const aoaRow = aoa[r] ?? []
    for (let c = 0; c <= maxCol; c += 1) {
      if (covered.has(`${r}:${c}`)) continue
      const cell = document.createElement('td')
      cell.textContent = String(aoaRow[c] ?? '')
      cell.style.border = '1px solid #d6d6d6'
      cell.style.padding = '3px 8px'
      cell.style.minWidth = '24px'
      if (r === 0) { cell.style.fontWeight = '600'; cell.style.backgroundColor = '#f5f6f8' }
      const span = mergeAt(r, c)
      if (span !== undefined) {
        if (span.colspan > 1) cell.colSpan = span.colspan
        if (span.rowspan > 1) cell.rowSpan = span.rowspan
      }
      tr.append(cell)
    }
    tbody.append(tr)
  }
  table.append(tbody)
  return table
}

export async function renderSpreadsheet(
  bytes: ArrayBuffer,
  container: HTMLElement,
  _signal?: AbortSignal,
): Promise<() => void> {
  const workbook = XLSX.read(bytes, { type: 'array' })
  container.replaceChildren()
  container.style.overflow = 'auto'
  const multi = workbook.SheetNames.length > 1
  for (const name of workbook.SheetNames) {
    const ws = workbook.Sheets[name]
    if (ws === undefined) continue
    if (multi) {
      const title = document.createElement('div')
      title.textContent = name
      title.style.fontWeight = '700'
      title.style.padding = '6px 10px'
      title.style.fontSize = '13px'
      container.append(title)
    }
    container.append(buildSheetTable(ws))
  }
  return () => { container.replaceChildren() }
}

export async function renderPptx(
  bytes: ArrayBuffer,
  container: HTMLElement,
  signal?: AbortSignal,
): Promise<() => void> {
  const viewer = await PptxViewer.open(bytes, container, {
    fitMode: 'contain',
    renderMode: 'list',
    listOptions: { showSlideLabels: true },
    ...(signal !== undefined ? { signal } : {}),
  })
  return () => {
    viewer.destroy()
    container.replaceChildren()
  }
}
