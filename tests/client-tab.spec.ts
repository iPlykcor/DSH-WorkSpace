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
import { apply, inject } from '../src/client/index.tsx'
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
  commands: Array<Record<string, unknown>>
  opened: Array<{ kind: string; target: unknown }>
  effects: Array<() => void>
}

/**
 * Build a fake client context: the optional `sidebarRightTabs` registry, the two
 * slot-seat APIs `registerMultiRootTab` drives, and the locale / effect / inject
 * / shortcuts / navigation faces the client apply reaches for.
 * @param options - `withTabs: false` models a host older than DSH 0.1.5.
 * @returns the fake mount's context and observations.
 */
function fakeCtx(options: { withTabs?: boolean } = {}): Fake {
  const typeDefinitions: Array<Record<string, unknown>> = []
  const seats: Array<{ name: string; key?: string }> = []
  const disposed: string[] = []
  const commands: Array<Record<string, unknown>> = []
  const opened: Array<{ kind: string; target: unknown }> = []
  const effects: Array<() => void> = []
  const ctx = {
    get: (name: string) => (name === 'sidebarRightTabs' && options.withTabs !== false
      ? {
        register(definition: Record<string, unknown>): () => void {
          typeDefinitions.push(definition)
          return () => { disposed.push('type') }
        },
      }
      : name === 'shortcuts'
        ? {
          register(command: Record<string, unknown>): () => void {
            commands.push(command)
            return () => { disposed.push('shortcut') }
          },
        }
        : name === 'sidebarRight'
          ? {
            // No focused element means the keystroke came from outside any
            // mounted Session, which is the refusal branch.
            commandTarget: (element?: Element | null) => (element === null || element === undefined
              ? undefined
              : { sessionId: 's1' }),
            openTabFromTarget: (kind: string, target: unknown): void => {
              opened.push({ kind, target })
            },
          }
          : undefined),
    // The real `effect` runs the body at once and keeps its disposer for
    // teardown; the fake only needs the "runs at once" half.
    effect: (body: () => unknown): (() => void) => {
      const off = body()
      const disposer = typeof off === 'function' ? off as () => void : () => {}
      effects.push(disposer)
      return disposer
    },
    // The real `inject` waits for the dependency and then runs the callback with a
    // scope carrying it. The fake resolves immediately: what is under test is that
    // the plugin ASKS for the service, not cordis's scheduler. Note what the
    // callback does NOT do — it reads its services with `ctx.get`, because
    // declaring them instead is what stopped DSH from starting in 0.3.1.
    inject: (_deps: string[], callback: () => void): void => { callback() },
    locale: {
      getSnapshot: () => ({ active: 'zh' }),
      subscribe: () => () => {},
      register: () => () => {},
    },
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
  return { ctx, typeDefinitions, seats, disposed, commands, opened, effects }
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
    // ... and the list must not GROW. 0.3.1 added `shortcuts` and `sidebarRight`
    // to it and DSH stopped starting; the shell had to be reinstalled. Services
    // needed after mount are reached with `ctx.get(name)` inside a `ctx.inject`
    // wrapper, never by declaring them here. Exact equality, so a new entry has
    // to be a deliberate decision.
    expect([...inject].sort()).toEqual(['locale', 'sessions', 'sidebarRightTabs', 'slots'])
  })
})

describe('operation-space keyboard entry', () => {
  it('points the start-page capsule at the ONE command id it registers', () => {
    const fake = fakeCtx()
    apply(fake.ctx)
    const guide = (fake.typeDefinitions[0]!.guide as Array<{
      id: string
      commandId?: string
      icon?: unknown
    }>)[0]!
    expect(guide.id).toBe('operationSpace')
    expect(fake.commands).toHaveLength(1)
    expect(fake.commands[0]!.id).toBe('octopus.operationSpace')
    // A mismatch here ships a capsule with no keycaps and no error anywhere.
    expect(guide.commandId).toBe(fake.commands[0]!.id)
    // Without an icon the platform draws its own cube placeholder instead of the
    // artwork this package ships (see tests/guide-artwork.spec.tsx for what it is).
    expect(typeof guide.icon).toBe('function')
  })

  it('binds Ctrl+Alt+S on exactly the profiles the web rule admits', () => {
    const fake = fakeCtx()
    apply(fake.ctx)
    const defaults = fake.commands[0]!.defaults as Record<string, { code: string; modifiers: string[] }>
    // `web:linux` is absent on purpose: the web rule admits Linux only for a tiny
    // fixed set, so declaring it would make `register` throw.
    expect(Object.keys(defaults).sort()).toEqual([
      'desktop:linux', 'desktop:macos', 'desktop:windows', 'web:macos', 'web:windows',
    ])
    for (const binding of Object.values(defaults)) {
      expect(binding.code).toBe('KeyS')
      expect(binding.modifiers).toEqual(['primary', 'alt'])
    }
  })

  it('refuses without a pane, and opens the captured pane when there is one', () => {
    const fake = fakeCtx()
    apply(fake.ctx)
    const resolve = fake.commands[0]!.resolve as (input: { target: Element | null }) => {
      status: string
      reason?: string
      run?: () => void
    }
    // No mounted Session: a refusal with a reason, not a guess at somebody
    // else's pane.
    expect(resolve({ target: null })).toEqual({ status: 'blocked', reason: '当前没有可用的会话面板' })
    const resolution = resolve({ target: {} as Element })
    expect(resolution.status).toBe('handled')
    resolution.run!()
    expect(fake.opened).toEqual([
      { kind: 'octopusOperationSpace', target: { sessionId: 's1' } },
    ])
  })

  it('localizes the capsule description in both languages', () => {
    const fake = fakeCtx()
    apply(fake.ctx)
    const description = (fake.typeDefinitions[0]!.guide as Array<{ description: () => string }>)[0]!
      .description
    pinLocale('zh')
    expect(description()).toBe('在会话工作区内高效访问工作区外的资源。')
    pinLocale('en')
    expect(description()).toBe('Reach resources outside the session workspace, efficiently.')
  })

  it('owns every registration through an effect, so teardown leaves nothing behind', () => {
    const fake = fakeCtx()
    apply(fake.ctx)
    for (const dispose of fake.effects) dispose()
    expect([...fake.disposed].sort()).toEqual([
      'octopus-operation-space', 'octopus-operation-space', 'shortcut', 'type',
    ])
  })
})

describe('operation-space copy', () => {
  it('has no dead key: every declared key is referenced by the tab or the shortcut source', async () => {
    // The dictionaries are the tab's whole vocabulary, so a key nobody calls is
    // dead weight in two languages. Reading the sources keeps this honest without
    // a hand-maintained list — including the keyboard entry, which owns the
    // refusal copy.
    const [tab, shortcut, menu, rowMenu] = await Promise.all([
      readFile(new URL('../src/client/multiroot-tab.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../src/client/shortcut.ts', import.meta.url), 'utf8'),
      // The body's right-click menu owns copy of its own (the one trust level it
      // offers, all the "waiting for a folder" answers), so it counts as a caller
      // exactly like the tab and the keyboard entry.
      readFile(new URL('../src/client/body-menu.tsx', import.meta.url), 'utf8'),
      // So does a row's menu: the two row labels, the implicit-root explanation
      // and the removal confirmation's four labels live there or in the tab.
      readFile(new URL('../src/client/row-menu.tsx', import.meta.url), 'utf8'),
    ])
    const referenced = new Set(
      [...`${tab}\n${shortcut}\n${menu}\n${rowMenu}`.matchAll(/\bt\('([A-Za-z]+)'/g)].map(match => match[1]),
    )
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
