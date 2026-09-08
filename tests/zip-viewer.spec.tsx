/**
 * ZipView tests (src/client/ZipView.tsx, the archive folder-listing viewer): the
 * component loads the `zip`/`archive` chunk, reads an archive, renders a
 * navigable tree, and shows entries read-only (no per-file content preview).
 * Uses the test chunk registry (registerChunkForTests) with fake readers.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderRoot } from './test-utils.ts'
import { ZipView } from '../src/client/ZipView.tsx'
import { registerChunkForTests, resetChunks } from '../src/client/chunk-loader.ts'
import type { ZipArchive } from '../src/client/zip-types.ts'
import type { SessionScope } from '../src/client/api.ts'

/** A tiny in-memory archive fixture: one dir, one dir file, one text file. */
function makeArchive(): ZipArchive {
  const files = new Map<string, Uint8Array>()
  files.set('README.md', new TextEncoder().encode('# Hello'))
  files.set('src/index.ts', new TextEncoder().encode('const a = 1'))
  files.set('docs/nested/notes.txt', new TextEncoder().encode('nested'))
  const dirs = new Set<string>(['src', 'docs', 'docs/nested'])
  return { files, dirs }
}

const scope: SessionScope = { sessionId: 's1' }
const customData = new ArrayBuffer(4) // fake readZip ignores the bytes

beforeEach(() => {
  resetChunks()
  registerChunkForTests('zip', async () => ({
    readZip: vi.fn(() => makeArchive()),
    textOf: vi.fn((d: Uint8Array) => new TextDecoder().decode(d)),
    extOfPath: vi.fn((p: string) => p.slice(p.lastIndexOf('.') + 1)),
  }))
  registerChunkForTests('editor', async () => ({ TextEditor: () => null }))
  registerChunkForTests('office', async () => ({}))
  registerChunkForTests('archive', async () => ({
    read7z: vi.fn(async () => makeArchive()),
    readRar: vi.fn(async () => makeArchive()),
  }))
})

afterEach(() => {
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

const rows = (container: HTMLElement): string[] => Array.from(container.querySelectorAll('[data-dsw-row]')).map(el => (el.textContent ?? '').trim()).filter(Boolean)

describe('ZipView', () => {
  it('lists top-level archive entries as a tree (folders + files)', async () => {
    const { container } = renderRoot(createElement(ZipView, { scope, path: '/w/archive.zip', customData }))
    await vi.waitFor(() => expect(container.textContent).toContain('README.md'), { timeout: 1000 })
    expect(rows(container)).toEqual(expect.arrayContaining(['▶docs', '▶src', '·README.md']))
  })

  it('expands a folder to reveal its children', async () => {
    const { container } = renderRoot(createElement(ZipView, { scope, path: '/w/archive.zip', customData }))
    await vi.waitFor(() => expect(container.textContent).toContain('README.md'), { timeout: 1000 })
    const src = Array.from(container.querySelectorAll<HTMLElement>('[data-dsw-row]')).find(el => (el.textContent ?? '').includes('src'))!
    src.click()
    await vi.waitFor(() => expect(rows(container)).toContain('·index.ts'), { timeout: 1000 })
  })

  it('shows entries read-only — clicking a file does NOT preview its content', async () => {
    const { container } = renderRoot(createElement(ZipView, { scope, path: '/w/archive.zip', customData }))
    await vi.waitFor(() => expect(container.textContent).toContain('README.md'), { timeout: 1000 })
    const readme = Array.from(container.querySelectorAll<HTMLElement>('[data-dsw-row]')).find(el => (el.textContent ?? '').includes('README.md'))!
    readme.click()
    // No content preview is rendered: the tree stays, and no <pre>/stage exists.
    expect(container.querySelector('pre')).toBeNull()
    expect(container.textContent).toContain('README.md')
  })

  it('routes a 7z-magic archive to the `archive` chunk read7z reader', async () => {
    // 37 7A BC AF 27 1C = the 7z signature; the fake read7z ignores the bytes.
    const sevenZ = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x00]).buffer as ArrayBuffer
    const { container } = renderRoot(createElement(ZipView, { scope, path: '/w/a.7z', customData: sevenZ }))
    await vi.waitFor(() => expect(container.textContent).toContain('README.md'), { timeout: 1000 })
    expect(rows(container)).toEqual(expect.arrayContaining(['▶docs', '▶src', '·README.md']))
  })
})
