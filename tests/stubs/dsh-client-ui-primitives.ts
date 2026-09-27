/**
 * Test stub for the DSH platform module `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The plugin consumes that package as a PLATFORM MODULE: it is a peerDependency
 * and the client-bundle purity gate keeps it external, because the host injects
 * it at mount time. Its own transitive dependencies (`clsx`, katex css, …)
 * belong to the HOST's install, not to this repo's dev tree — so importing the
 * real built bundle from a test would make this suite depend on the host's
 * internal dependency graph, and in practice it does not even resolve
 * (`Cannot find package 'clsx'`).
 *
 * `vitest.config.ts` therefore aliases the specifier here. TypeScript still
 * type-checks the JSX against the REAL package's declarations — only the test
 * runtime uses these stand-ins, which is exactly how the host supplies them.
 */
import { createElement, type ReactElement, type ReactNode } from 'react'

/** The subset of the real `IconProps` the tab passes. */
interface IconProps {
  size?: number
  className?: string
}

/** A stand-in icon: renders nothing (icons are decoration, never behaviour). */
const StubIcon = (_props: IconProps): null => null

/**
 * The icons the operation-space tab and its row actions render with. Every name
 * the client half imports must exist here or the named import throws at load
 * time. The `Medium` folder/refresh/close set is gone: the tab now draws the
 * SAME glyphs DSH's built-in 工作区文件 pane draws — `Regular` folders and the
 * product's own `FileTypeIcon` for files — so the stub follows it.
 */
export const IconCloseFillRegular = StubIcon
export const IconFolderCloseRegular = StubIcon
export const IconFolderOpenRegular = StubIcon
export const IconFolderOpenOutlineRegular = StubIcon
export const IconRefreshOutlineRegular = StubIcon
export const IconInfoOutlineRegular = StubIcon

/**
 * Stand-in for the platform's file-type glyph. The real component draws a
 * category-coloured SVG chosen by the product's classifier; a test only needs to
 * know WHICH kind reached it (that is the part this plugin chooses), so the
 * stand-in exposes it as an attribute instead of drawing anything.
 * @param props.kind - the resolved category the tab asked for.
 * @returns a span carrying the kind.
 */
export function FileTypeIcon({ kind }: { kind?: string; path?: string; size?: number }): ReactElement {
  return createElement('span', { 'data-file-type': kind ?? '' })
}

/**
 * Stand-in classifier. The real one is the product's own table of name and
 * extension rules (hundreds of entries); re-implementing it here would test a
 * copy instead of a contract, so every path answers with the fallback category —
 * which is all a row test needs.
 * @returns the fallback category.
 */
export function classifyFileType(_path: string, _context?: unknown): string {
  return 'other'
}

/**
 * Stand-in for the platform path label. The real component splits a path into
 * subdued directories and a primary filename and owns its own tooltip; a test
 * only needs the exact path the pane put in its header, so the stand-in renders
 * it as text and as an attribute.
 * @param props.path - the absolute path to show.
 * @returns the label.
 */
export function PathLabel({ path }: { path: string; className?: string; style?: unknown }): ReactElement {
  return createElement('span', { 'data-path-label': path }, path)
}

/**
 * Stand-in for the platform Tooltip. The real component renders a
 * fixed-position bubble (and needs a DOM); a test only needs to know WHICH label
 * the badge handed it, so this renders the anchor and exposes the label as a
 * data attribute — which is exactly the part of the contract this plugin owns.
 * @param props.label - bubble text, or the resolver the real component evaluates while visible.
 * @param props.children - the single anchor element.
 * @returns the anchor, carrying the label for assertions.
 */
export function Tooltip({ label, children }: {
  label?: string | (() => string) | undefined
  children?: ReactNode | undefined
}): ReactElement {
  const text = typeof label === 'function' ? label() : label
  return createElement('span', { 'data-tooltip-label': text ?? '' }, children)
}

/** One entry of the stand-in menu: rows carry their label, non-rows their type. */
export interface MenuEntry {
  id: string
  label?: ReactNode
  disabled?: boolean
  type?: 'separator' | 'label'
  text?: string
}

/**
 * Stand-in for the platform menu. The real component portals a card, walks the
 * rows with the keyboard and returns focus on close; a test only needs to know
 * WHICH rows and WHICH disabled flags reached it, so the stand-in renders them as
 * attributes and exposes the selection callback as a real button per row.
 * @param props.items - the data rows the tab built.
 * @param props.open - whether the card is showing.
 * @param props.onSelect - row activation callback.
 * @param props.onClose - close callback.
 * @param props.children - component-rendered rows (unused by this plugin).
 * @returns a list of rows, or null while closed.
 */
export function Menu({ items, open, onSelect, onClose, children }: {
  items?: readonly MenuEntry[] | undefined
  open?: boolean | undefined
  onSelect?: ((id: string) => void) | undefined
  onClose?: (() => void) | undefined
  children?: ReactNode | undefined
  [key: string]: unknown
}): ReactElement | null {
  if (open !== true) return null
  return createElement(
    'div',
    { 'data-menu': 'open', 'data-on-close': onClose === undefined ? '' : 'set' },
    (items ?? []).map((entry) => createElement(
      'button',
      {
        key: entry.id,
        type: 'button',
        'data-menu-row': entry.id,
        'data-menu-kind': entry.type ?? 'item',
        'data-menu-text': entry.text ?? '',
        'data-menu-disabled': entry.disabled === true ? 'true' : 'false',
        onClick: () => { onSelect?.(entry.id) },
      },
      entry.text ?? (typeof entry.label === 'string' ? entry.label : entry.id),
    )),
    children,
  )
}

/**
 * Stand-in for the component-rendered menu row: renders the label it was given
 * and reports its activation, which is the part the plugin owns.
 * @param props.children - the row label.
 * @param props.onSelect - activation callback.
 * @returns a button carrying the label.
 */
export function MenuItemButton({ children, onSelect, disabled }: {
  children?: ReactNode | undefined
  onSelect?: (() => void) | undefined
  disabled?: boolean | undefined
  [key: string]: unknown
}): ReactElement {
  return createElement(
    'button',
    {
      type: 'button',
      'data-menu-item-button': '',
      'data-menu-disabled': disabled === true ? 'true' : 'false',
      onClick: () => { onSelect?.() },
    },
    children,
  )
}

/**
 * Stand-in for the platform's risky-action confirmation. The real component is an
 * in-page card whose primary action stays unavailable until the caller-controlled
 * acknowledgement is ticked; a test only needs to see WHICH labels reached it and
 * to drive its three callbacks, so the stand-in renders the labels as attributes
 * and keeps the same "confirm is disabled until acknowledged" rule.
 * @param props.open - whether the confirmation is showing.
 * @param props.acknowledged - the acknowledgement state the owner controls.
 * @param props.disabled - whether a running change blocks the primary action.
 * @param props.onAcknowledgedChange - acknowledgement toggle.
 * @param props.onConfirm - primary action.
 * @param props.onCancel - cancel action.
 * @returns the confirmation's surface, or null while closed.
 */
export function RiskConfirmation({
  open, title, description, acknowledgeLabel, confirmLabel, acknowledged, disabled,
  onAcknowledgedChange, onConfirm, onCancel,
}: {
  open?: boolean | undefined
  title?: string | undefined
  description?: string | undefined
  acknowledgeLabel?: string | undefined
  confirmLabel?: string | undefined
  acknowledged?: boolean | undefined
  disabled?: boolean | undefined
  onAcknowledgedChange?: ((value: boolean) => void) | undefined
  onConfirm?: (() => void) | undefined
  onCancel?: (() => void) | undefined
  [key: string]: unknown
}): ReactElement | null {
  if (open !== true) return null
  return createElement(
    'div',
    {
      'data-risk': 'open',
      'data-risk-title': title ?? '',
      'data-risk-description': description ?? '',
      'data-risk-acknowledged': acknowledged === true ? 'true' : 'false',
      'data-risk-disabled': disabled === true ? 'true' : 'false',
    },
    createElement('button', {
      type: 'button',
      'data-risk-acknowledge': acknowledgeLabel ?? '',
      onClick: () => { onAcknowledgedChange?.(acknowledged !== true) },
    }, acknowledgeLabel ?? ''),
    createElement('button', {
      type: 'button',
      'data-risk-confirm': confirmLabel ?? '',
      disabled: disabled === true || acknowledged !== true,
      onClick: () => { onConfirm?.() },
    }, confirmLabel ?? ''),
    createElement('button', {
      type: 'button',
      'data-risk-cancel': '',
      onClick: () => { onCancel?.() },
    }, 'cancel'),
  )
}
