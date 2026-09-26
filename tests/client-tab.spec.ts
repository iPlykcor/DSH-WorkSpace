/**
 * The client half's registration contract, and its copy.
 *
 * The operation-space tab is the plugin's ONLY visible surface, and it is
 * assembled from three registrations that must agree on ONE identity: the tab
 * type's `id`, and the `key` of both slot seats. Nothing else would notice a
 * disagreement — `ctx.slots` and `ctx.sidebarRightTabs` are untyped at the call
 * site, so a wrong seat key or a wrong type id produces a tab that silently
 * renders nothing, or never appears at all. A real host cannot be asked about
 * this without browser automation, so the wiring is pinned here instead.
 *
 * The copy tests are the second half: they keep the dictionaries honest (no
 * dead key survives in only one language, no key leaks through as its own
 * text, placeholders substitute), because the tab's entire user-facing
 * vocabulary lives in that one file.
 */
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { attachLocale, en, LOCALE_NS, t, zh } from '../src/client/locales.ts'
import { inject } from '../src/client/index.tsx'
import { registerMultiRootTab } from '../src/client/multiroot-tab.tsx'
import type { Context } from '../src/context-types.ts'

/** The tab identity every one of the three registrations must share. */
const TAB_ID = 'octopus-operation-space'

/** What one fake client mount observed. */
interface Fake {
  ctx: Context
  typeDefinitions: Array<Record<string, unknown>>
  seats: Array<{ name: string; key?: string }>
  disposed: string[]
}

/**
 * Build a fake client context: `sidebarRightTabs` (optional) and the two
 * slot-seat APIs `registerMultiRootTab` drives.
 * @param options - `withTabs: false` models a host older than DSH 0.1.5.
 * @returns the fake mount's context and observations.
 */
function fakeCtx(options: { withTabs?: boolean } = {}): Fake {
  const typeDefinitions: Array<Record<string, unknown>> = []
  const seats: Array<{ name: string; key?: string }> = []
  const disposed: string[] = []
  const ctx = {
    get: (name: string) => (name === 'sidebarRightTabs' && options.withTabs !== false
      ? {
        register(definition: Record<string, unknown>): () => void {
          typeDefinitions.push(definition)
          return () => { disposed.push('type') }
        },
      }
      : undefined),
    slots: {
      // The real `inject` waits for the seat to be declared, then runs the
      // callback; the fake runs it immediately and returns its disposer.
      inject: (_key: string, callback: () => unknown): unknown => callback(),
      register: (options: { name: string; key?: string }, _component: unknown): () => void => {
        seats.push({ name: options.name, ...(options.key === undefined ? {} : { key: options.key }) })
        return () => { disposed.push(options.key ?? options.name) }
      },
    },
  } as unknown as Context
  return { ctx, typeDefinitions, seats, disposed }
}

/** Pin the active locale for one assertion. */
function pinLocale(active: 'zh' | 'en'): void {
  attachLocale({ getSnapshot: () => ({ active }) })
}

afterEach(() => { attachLocale(undefined) })

describe('operation-space tab registration', () => {
  it('is a graceful no-op on a host without sidebarRightTabs (DSH < 0.1.5)', () => {
    const fake = fakeCtx({ withTabs: false })
    const dispose = registerMultiRootTab(fake.ctx)
    // No tab, no seat, and — importantly — no throw that would take the whole
    // client plugin tree down on an older host.
    expect(fake.typeDefinitions).toEqual([])
    expect(fake.seats).toEqual([])
    expect(() => { dispose() }).not.toThrow()
  })

  it('registers exactly one extension page type under the stable id', () => {
    const fake = fakeCtx()
    registerMultiRootTab(fake.ctx)
    expect(fake.typeDefinitions).toHaveLength(1)
    const definition = fake.typeDefinitions[0]!
    expect(definition.id).toBe(TAB_ID)
    expect(definition.kind).toBe('octopusOperationSpace')
    expect(definition.priority).toBe('extension')
    expect((definition.guide as Array<{ order: number }>)[0]!.order).toBe(20)
  })

  it('keys BOTH slot seats with the type id, or the tab renders empty', () => {
    const fake = fakeCtx()
    registerMultiRootTab(fake.ctx)
    expect(fake.seats).toEqual([
      { name: 'sidebar.right.pane.tab', key: TAB_ID },
      { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
    ])
  })

  it('disposes the type and both seats', () => {
    const fake = fakeCtx()
    registerMultiRootTab(fake.ctx)()
    expect(fake.disposed).toHaveLength(3)
  })

  it('localizes the tab title and guide entry through the active locale', () => {
    const fake = fakeCtx()
    registerMultiRootTab(fake.ctx)
    const definition = fake.typeDefinitions[0]!
    const title = definition.title as () => string
    const guide = (definition.guide as Array<{ title: () => string }>)[0]!.title
    pinLocale('zh')
    expect(title()).toBe('章鱼作业区')
    expect(guide()).toBe('章鱼作业区')
    pinLocale('en')
    expect(title()).toBe('Operation Space')
    expect(guide()).toBe('Operation Space')
  })

  it('declares sidebarRightTabs as a dependency instead of only probing for it', () => {
    // This is not bookkeeping. The service is provided by the built-in right
    // Sidebar, whose own inject list is LONGER than ours (layout / resources /
    // uiSession / shortcuts), so cordis legitimately activates this plugin
    // first. A probe then finds nothing and `registerMultiRootTab` returns a
    // no-op that never retries: the tab is simply absent, with no error in the
    // console or the host log. Declaring the dependency is what orders the two,
    // and every built-in DSH plugin that uses the service does the same.
    expect(inject).toContain('sidebarRightTabs')
    // These must stay declared too: dropping one breaks the tab body.
    expect(inject).toContain('slots')
    expect(inject).toContain('sessions')
    expect(inject).toContain('locale')
  })
})

describe('operation-space copy', () => {
  it('has no dead key: every declared key is referenced by the tab source', async () => {
    // The dictionaries are the tab's whole vocabulary, so a key nobody calls is
    // dead weight in two languages. Reading the source keeps this honest
    // without a hand-maintained list.
    const source = await readFile(new URL('../src/client/multiroot-tab.tsx', import.meta.url), 'utf8')
    const referenced = new Set([...source.matchAll(/\bt\('([A-Za-z]+)'/g)].map(match => match[1]))
    expect(Object.keys(zh).filter(key => !referenced.has(key))).toEqual([])
  })

  it('resolves every key in both locales, never leaking the key as its own text', () => {
    for (const active of ['zh', 'en'] as const) {
      pinLocale(active)
      for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
        const text = t(key)
        expect(text, `${active} is missing copy for "${key}"`).not.toBe('')
        expect(text, `${active} leaked the raw key "${key}"`).not.toBe(key)
      }
    }
  })

  it('keeps zh and en in step', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('substitutes placeholders rather than leaving braces', () => {
    pinLocale('zh')
    expect(t('workspaceRoots', { n: 3 })).toBe('3 个根目录')
    expect(t('workspaceViolationMeta', { root: 'docs', kind: 'write' })).toBe('只读根 docs · write')
    expect(t('workspaceApplyFailed', { message: 'ENOENT' })).toBe('应用失败：ENOENT')
    pinLocale('en')
    expect(t('workspaceRoots', { n: 1 })).toBe('1 roots')
  })

  it('pins the plugin identity strings', () => {
    expect(zh.operationSpace).toBe('章鱼作业区')
    expect(en.operationSpace).toBe('Operation Space')
    expect(LOCALE_NS).toBe('octopus')
  })
})
