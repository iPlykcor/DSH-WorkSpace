/**
 * The lazy `office` chunk: the docx/xlsx/pptx renderers, fetched by the editor
 * on first open of an office file (see chunk-loader.ts). The core bundle never
 * statically imports this entry.
 *
 * Renderers:
 * - docx → `docx-preview` (MIT) — close-to-Word DOM rendering.
 * - xlsx → SheetJS (`xlsx`, Apache-2.0) parse into `@fortune-sheet/react`
 *   (MIT, the modern React successor of x-spreadsheet) styled/grid view.
 * - pptx → `@aiden0z/pptx-renderer` (Apache-2.0) — DOM/SVG slide renderer.
 *
 * Every render function takes the raw file bytes + a container element and
 * returns an optional disposer (null on abort/teardown).
 */
import { renderAsync } from 'docx-preview'
import { createRoot, type Root } from 'react-dom/client'
import { Workbook } from '@fortune-sheet/react'
import '@fortune-sheet/react/dist/index.css'
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

/** xlsx → FortuneSheet sheets ({ name, celldata, merges, row, column }). */
function xlsxToSheets(bytes: ArrayBuffer): Array<{
  name: string
  celldata: Array<{ r: number; c: number; v: unknown }>
  merges?: Array<{ row: number; col: number; row2: number; col2: number }>
  row: number
  column: number
}> {
  const workbook = XLSX.read(bytes, { type: 'array' })
  return workbook.SheetNames.map((name) => {
    const ws = workbook.Sheets[name]
    if (ws === undefined) return { name, celldata: [], row: 1, column: 1 }
    // header:1 → a 2-D array of cell values (raw:false keeps display text);
    // defval '' keeps empty cells from collapsing.
    const aoa = XLSX.utils.sheet_to_json(ws as never, { header: 1, raw: false, defval: '' }) as unknown[][]
    const celldata: Array<{ r: number; c: number; v: unknown }> = []
    let maxRow = 0
    let maxCol = 0
    aoa.forEach((row, r) => {
      row.forEach((v, c) => {
        if (v !== '' && v !== null && v !== undefined) celldata.push({ r, c, v })
        if (c > maxCol) maxCol = c
      })
      if (r > maxRow) maxRow = r
    })
    const merges = (ws['!merges'] ?? []).map((m) => ({ row: m.s.r, col: m.s.c, row2: m.e.r, col2: m.e.c }))
    return {
      name,
      celldata,
      ...(merges.length > 0 ? { merges } : {}),
      row: maxRow + 1,
      column: maxCol + 1,
    }
  })
}

export async function renderSpreadsheet(
  bytes: ArrayBuffer,
  container: HTMLElement,
  _signal?: AbortSignal,
): Promise<() => void> {
  const sheets = xlsxToSheets(bytes)
  const root: Root = createRoot(container)
  root.render(<Workbook data={sheets as never} />)
  return () => {
    root.unmount()
    container.replaceChildren()
  }
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
