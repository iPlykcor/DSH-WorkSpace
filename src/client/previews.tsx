/**
 * Document-preview contributions for the DSH 0.1.5+ built-in right Sidebar.
 *
 * The plugin registers the file kinds the product does NOT ship — Office
 * (docx/xlsx/pptx), archives (zip/7z/rar, shown as a read-only listing) and
 * media (video/audio) — into the built-in document-preview registry, so
 * opening such a file in the built-in Files tab renders through this plugin's
 * existing lazy chunks.
 *
 * The contract (see `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`):
 *   1. the implementation into `ctx.documentPreviews` — id, suffixes, the copy
 *      label, and the content-loading mode (`bytes-complete` gives the body the
 *      whole file);
 *   2. the body into the keyed `sidebar.right.tab.document` seat under that id.
 *
 * `priority: 'extension'` outranks the product's own implementations for the
 * same suffix. Labels reuse the plugin's EXISTING locale keys, so no dictionary
 * needs a new entry.
 */
import type { ReactNode } from 'react'
import { FilePreviewBody } from './FilePreviewBody.tsx'
import { MEDIA_EXTS } from './media.ts'
import { t } from './locales.ts'
import type { Context, DocumentPreviewsFace } from '../context-types.ts'

/** Bytes the owner hands a `bytes-complete` body. */
interface BytesContent { readonly kind: 'bytes'; readonly data: Uint8Array }
/** Text the owner hands a `text-pages` body (unused here, kept for the union). */
interface TextContent { readonly kind: 'text'; readonly text: string }
type DocumentContentFace = BytesContent | TextContent

/** The owner share a `sidebar.right.tab.document` body receives. */
interface DocumentBodyProps {
  readonly resourceAddress?: string
  readonly content?: DocumentContentFace
}

/** One registered implementation: its id, suffixes, and copy label. */
interface PreviewSpec { readonly id: string; readonly extensions: readonly string[]; readonly title: () => string }

/** The implementations this plugin contributes (labels reuse existing keys). */
const SPECS: readonly PreviewSpec[] = [
  { id: 'dsh-workspace/docx', extensions: ['docx'], title: () => t('viewerDocx') },
  { id: 'dsh-workspace/xlsx', extensions: ['xlsx'], title: () => t('viewerSpreadsheet') },
  { id: 'dsh-workspace/pptx', extensions: ['pptx'], title: () => t('viewerPresentation') },
  { id: 'dsh-workspace/archive', extensions: ['zip', '7z', 'rar'], title: () => t('viewerZip') },
  { id: 'dsh-workspace/media', extensions: [...MEDIA_EXTS], title: () => t('viewerVideo') },
]

/** Copy the file bytes out of the owner's view without sharing its buffer. */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}

/** The session id carried by a `dsh-resource://file/session/<id>/…` address. */
function scopeOfAddress(address: string): string {
  const match = /^dsh-resource:\/\/file\/session\/([^/]+)\//.exec(address)
  return match?.[1] ?? ''
}

/** Build one implementation body: it renders the owner's bytes by extension. */
function makePreviewBody(): (props: DocumentBodyProps) => ReactNode {
  return function DocumentPreviewBody({ resourceAddress, content }: DocumentBodyProps): ReactNode {
    if (content === undefined || content.kind !== 'bytes') {
      return <div style={{ padding: 12, fontSize: 13, opacity: 0.7 }}>{t('loading')}</div>
    }
    const address = resourceAddress ?? ''
    return (
      <FilePreviewBody
        scope={{ sessionId: scopeOfAddress(address) }}
        path={address}
        bytes={toArrayBuffer(content.data)}
      />
    )
  }
}

/**
 * Register every contributed document preview into the built-in Sidebar.
 * No-op on hosts without the 0.1.5 registry.
 * @param ctx - the client cordis context.
 * @returns a disposer unregistering every implementation and body.
 */
export function registerDocumentPreviews(ctx: Context): () => void {
  const registry = ctx.get('documentPreviews') as DocumentPreviewsFace | undefined
  if (registry === undefined) return () => {}
  const disposers: Array<() => void> = []
  for (const spec of SPECS) {
    disposers.push(registry.register({
      id: spec.id,
      extensions: spec.extensions,
      priority: 'extension',
      title: spec.title,
      loading: 'bytes-complete',
    }))
    disposers.push(ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
      name: 'sidebar.right.tab.document',
      key: spec.id,
    }, makePreviewBody())))
  }
  return () => { for (const dispose of disposers) dispose() }
}
