/**
 * OfficeView dispatch tests (src/client/OfficeView.tsx): the viewer loads the
 * `office` chunk lazily, calls the renderer matching its `viewerId`, passes the
 * raw `customData` bytes + the stage container, and teardown invokes the
 * renderer's disposer. Pins the docx/spreadsheet/presentation dispatch.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderRoot } from './test-utils.ts'
import { OfficeView } from '../src/client/OfficeView.tsx'
import { registerChunkForTests, resetChunks } from '../src/client/chunk-loader.ts'
import type { FileViewerProps } from '../src/client/service.ts'

function props(viewerId: string, customData: ArrayBuffer): FileViewerProps {
  return {
    ctx: {} as never,
    store: {} as never,
    scope: { sessionId: 's1' },
    path: '/w/file',
    title: 'file',
    viewerId,
    customData,
  }
}

beforeEach(() => {
  resetChunks()
})

afterEach(() => {
  for (const el of document.querySelectorAll('body > div')) el.remove()
})

describe('OfficeView', () => {
  it('loads the office chunk and dispatches docx to renderDocx', async () => {
    const dispose = vi.fn()
    const renderDocx = vi.fn(async (_bytes: ArrayBuffer, container: HTMLElement) => {
      container.setAttribute('data-rendered', 'docx')
      return dispose
    })
    registerChunkForTests('office', async () => ({ renderDocx, renderSpreadsheet: vi.fn(), renderPptx: vi.fn() }))
    const bytes = new ArrayBuffer(8)
    const { container, unmount } = renderRoot(createElement(OfficeView, props('docx', bytes)))
    await vi.waitFor(() => expect(container.querySelector('[data-rendered="docx"]')).not.toBeNull(), { timeout: 1000 })
    expect(renderDocx).toHaveBeenCalledTimes(1)
    expect(renderDocx.mock.calls[0]![0]).toBe(bytes)
    expect(renderDocx.mock.calls[0]![1]).toBeInstanceOf(HTMLElement)
    unmount()
    // The effect cleanup invoked the renderer's disposer.
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('dispatches spreadsheet to renderSpreadsheet', async () => {
    const renderSpreadsheet = vi.fn(async (_bytes: ArrayBuffer, container: HTMLElement) => {
      container.setAttribute('data-rendered', 'xlsx')
    })
    registerChunkForTests('office', async () => ({ renderDocx: vi.fn(), renderSpreadsheet, renderPptx: vi.fn() }))
    const { container } = renderRoot(createElement(OfficeView, props('spreadsheet', new ArrayBuffer(4))))
    await vi.waitFor(() => expect(container.querySelector('[data-rendered="xlsx"]')).not.toBeNull(), { timeout: 1000 })
    expect(renderSpreadsheet).toHaveBeenCalledTimes(1)
  })

  it('reports an error when the chunk renderer throws', async () => {
    registerChunkForTests('office', async () => ({
      renderDocx: vi.fn(async () => { throw new Error('boom') }),
      renderSpreadsheet: vi.fn(),
      renderPptx: vi.fn(),
    }))
    const { container } = renderRoot(createElement(OfficeView, props('docx', new ArrayBuffer(4))))
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull(), { timeout: 1000 })
    expect(container.textContent).toContain('boom')
  })
})
