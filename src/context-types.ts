/**
 * Structural types for the cordis services this plugin consumes, plus the
 * Context face both halves share.
 *
 * The type base is the vendored `@deepseek-ai/cordis` Context (the runtime DSH
 * actually runs); the service members this plugin touches are restated below
 * as structural mirrors and combined with the base by INTERSECTION.
 * Intersection (not `declare module` augmentation) is deliberate: DSH's own
 * packages already augment `@deepseek-ai/cordis`, and the host and client
 * packages declare *different* types for the same member — host
 * `sessions: SessionStore` vs client runtime `sessions: ISessions` — so a
 * single program that re-declares them would fail interface merging (TS2717).
 * Intersecting keeps every face available and lets each call site resolve
 * against the member it needs without any module-level conflict.
 *
 * `effect`, `get`, `provide`, `inject`, `logger`, `emit` and `isolate` come
 * from the vendored cordis base and are intentionally NOT restated here: their
 * strict shapes are the runtime contract (e.g. an effect body must return a
 * disposer). Only the string-keyed session-feed `on` overload is added,
 * because the cordis `on` is keyed to its own typed `Events` map and the
 * harness session feed is a plain string event.
 *
 * This file must stay FREE of Node.js types (`node:http`, `node:stream`,
 * `Buffer`): it is part of the CLIENT-reachable declaration graph, so a Node
 * import here would leak into browser-only consumer builds. The webServer
 * faces below are therefore structural mirrors with plain interfaces.
 */
import type { Context as CordisContext } from '@deepseek-ai/cordis'

/** The request face route handlers see (structural subset of node's
 *  IncomingMessage: the URL/method/header reads and the async body
 *  iteration `readJsonBody` uses). */
export interface SidebarHttpRequest {
  url?: string
  method?: string
  headers: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>
}

/** The response face route handlers write to (structural subset of node's
 *  ServerResponse: the status/header/body writes the routes use). */
export interface SidebarHttpResponse {
  statusCode: number
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Uint8Array): void
}

/** One named webserver route (mirror of the host-webserver WebRoute). */
export interface SidebarWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: SidebarHttpRequest, res: SidebarHttpResponse) => void | Promise<void>
}

/** The webServer service face this plugin uses. */
export interface SidebarWebServer {
  register(route: SidebarWebRoute): () => void
}

/** One content block a tool's `render` returns (text is all this plugin emits). */
export interface SidebarToolContentBlock {
  type: 'text'
  text: string
}

/** The per-call context a tool handler receives (the slice this plugin reads). */
export interface SidebarToolRunContext {
  /**
   * The agent on whose behalf the call runs. Optional in the real contract —
   * a non-agent caller has none — so a handler that needs a session must check.
   */
  agent?: { session: { id: string } }
  signal: AbortSignal
}

/**
 * One model-visible tool definition (mirror of @deepseek-ai/dsh-tools'
 * `ToolDefinition`, minus the presentation-only members this plugin ignores).
 *
 * TWO CONSTRAINTTS ARE THE WHOLE CONTRACT: `output` is MANDATORY — `execute`
 * returns the canonical JSON value that `output.schema` validates, and
 * `output.render` turns that value into the model-facing content blocks; and
 * `parameters` is raw JSON Schema (the DSL wrapper is a convenience this plugin
 * does not need, since its one tool takes no arguments).
 */
export interface SidebarToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    // Mutable array on purpose: the real `render` returns `ContentBlock[]`, and a
    // `readonly` return here is NOT assignable to it (the host declares `render`
    // as a property, so no method bivariance saves it). tests/host-types.spec.ts
    // is what caught that.
    render(args: unknown, value: unknown): SidebarToolContentBlock[]
  }
  execute(args: unknown, exec: SidebarToolRunContext): Promise<unknown>
}

/**
 * The tool registry face (`ctx.tools`). Registering here is what makes a
 * capability MODEL-visible rather than only UI-visible; the returned disposer
 * unregisters it (the runtime also owns it as a context effect).
 */
export interface SidebarToolsService {
  register(definition: SidebarToolDefinition): () => void
}

/** A published session's header slice the plugin reads (authoritative cwd). */
export interface SidebarSessionHeader {
  cwd?: string
}

/** The host session store face (`ctx.sessions.get(id)` returns the live session). */
export interface SidebarSessionStore {
  get(id: string): {
    header: SidebarSessionHeader
    /**
     * The live session's append-only event log as an immutable snapshot.
     * Read-only access — the read-only-write report folds `fs` write calls
     * out of it. (The `Session.events` property this face mirrored was
     * renamed to `snapshotEvents()` in DSH 0.1.2-alpha.4.)
     */
    snapshotEvents(): readonly SidebarSessionEvent[]
  } | undefined
}

/**
 * The web runtime service face (mirror of @deepseek-ai/dsh-web-app's
 * WebRuntimeValues): the bind-derived trust list the /api gateway's fence
 * accepts — LAN IP literals sampled when the server binds all interfaces,
 * plus explicit `--trusted-host` authorities.
 */
export interface SidebarWebRuntime {
  trustedHosts: readonly string[]
}

/** Registration options the plugin passes to `ctx.slots.register` (subset of the real options). */
export interface SidebarSlotRegisterOptions {
  name: string
  key?: string
  id?: string
  order?: number
  label?: string | (() => string)
  /** Chain routing selector (returns the matched value, or null to pass on). */
  select?: (owner: unknown) => unknown
  priority?: number
  locale?: string
  registrant?: string
  /** Business-face factory; args depend on the slot scope. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the host slots signature, where inject args are untyped; unknown[] would reject concrete-typed implementations (contravariance)
  inject?: (...args: any[]) => Record<string, unknown>
  children?: Record<string, unknown>
}

/** The client slots service face (register returns the disposer). */
export interface SidebarSlotsService {
  register(options: SidebarSlotRegisterOptions, component: unknown): () => void
  /**
   * Run a callback for each declaration lifetime of a slot (the runtime
   * SlotRegistry.inject): a no-op while the slot is undeclared, so the tab
   * body/title registration waits until DSH's Sidebar declares its seats.
   */
  inject(key: string, callback: () => () => void): () => void
}

/** The client session list row the tab reads (cwd + display title). */
export interface SidebarSessionSummary {
  id: string
  cwd?: string
  displayTitle: string
  /** Whether the session's agent is currently running. */
  running?: boolean
}

/**
 * Minimal structural mirror of one session event (the write-report input).
 *
 * `data` is deliberately `unknown`: the host types it per event variant
 * (`UserMessage`, tool results, …) and none of those carry an index signature,
 * so `Record<string, unknown>` is NOT a valid mirror of it — the compile-time
 * contract in `tests/host-types.spec.ts` rejects that spelling. Readers cast to
 * the shape of the variant they are actually looking at.
 */
export interface SidebarSessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

/** One open channel onto a stored session's log (subset of the host handle). */
export interface SidebarSessionHandle {
  /** The immutable stored header, fixed at `create`/`open`. */
  header: SidebarSessionHeader
  /** Read the log, or a slice of it; `events` is the caller-owned outer array. */
  read(offset?: number, length?: number): Promise<{ events: readonly SidebarSessionEvent[] }>
  /** Release the handle: idempotent, uncancellable, the one teardown. */
  close(): Promise<void>
}

/**
 *  The host session-persistence service face (subset of @deepseek-ai/dsh-session-persistence):
 *  metadata-only reads plus one open channel onto a stored log. Used to resolve
 *  a cold session's cwd and to fold its recorded write calls when the live
 *  session is no longer in the store.
 *
 *  THE HOST RENAMED THIS SURFACE and `tsc` could not tell: `ctx.get()` is
 *  untyped, so nothing checked the method name. Up to the 0.1.2 line it exposed
 *  a single `inspect(id)` returning `{ meta, events }`; on 0.1.7 it is
 *  `stat(id)` — lightweight header metadata, no log read — plus
 *  `open(id, access)` → a handle with `read()`/`close()`. A real mount smoke
 *  caught the stale `inspect` (HTTP 500 on the cold path);
 *  `tests/host-types.spec.ts` now pins this shape against the installed host
 *  typings so the next rename fails `pnpm typecheck` instead of production. */
export interface SidebarSessionPersistenceService {
  /** Lightweight stored-session metadata; `undefined` when it never persisted. */
  stat(sessionId: string): Promise<{ header: SidebarSessionHeader } | undefined>
  /** Open one channel onto a stored session's log. */
  open(sessionId: string, access: 'read' | 'write'): Promise<SidebarSessionHandle>
}

/** The client session list snapshot the tab subscribes to. */
export interface SidebarSessionList {
  current: string | undefined
  byId: Record<string, SidebarSessionSummary>
}

/** The client sessions service face (only the list feed is needed). */
export interface SidebarSessionsService {
  list: {
    getSnapshot(): SidebarSessionList
    subscribe(fn: () => void): () => void
  }
}

/**
 * The client locale service face (mirror of @deepseek-ai/dsh-client-locale's
 * LocaleRuntime — only the slices this plugin touches). The active locale is
 * the Host-backed preference (`locale.preference` in settings.yaml) rather
 * than the raw browser language, and the plugin's zh/en dictionaries register
 * into the service's namespace registry under `octopus`.
 */
export interface SidebarLocaleService {
  /** Current immutable locale snapshot (`active` is 'zh' | 'en' today). */
  getSnapshot(): { active: string }
  /** Subscribe to snapshot changes (locale switch or dictionary registration). */
  subscribe(fn: () => void): () => void
  /** Register one locale's dictionary for a namespace; returns the disposer. */
  register(ns: string, locale: string, dict: Record<string, string>): () => void
}

/**
 * The invariant service face (mirror of @deepseek-ai/dsh-invariants'
 * InvariantRegistry). The upstream augmentation does not reach this Context
 * (dual-cordis-instance resolution), so the register signature is restated
 * structurally, exactly like the other service faces above.
 */
export interface SidebarInvariantsService {
  /** Reserve one package's checks and install them in the service's child fiber. */
  register(
    packageName: string,
    installer: (ctx: Context, fail: (message: string) => never) => void | Promise<void>,
  ): () => void
}

/** One guide entry the right-Sidebar guide page offers (subset of the 0.1.5 contract). */
export interface SidebarRightGuideEntryFace {
  readonly order: number
  readonly title: () => string
  readonly description?: () => string
}

/** One registered right-Sidebar tab type (subset of the 0.1.5 `SidebarRightTabDefinition`). */
export interface SidebarRightTabDefinitionFace {
  /** Implementation identity; also the key its body/title register under. */
  readonly id: string
  /** Type discriminator the tab is opened by. */
  readonly kind: string
  /** Resource-address globs this type recognizes; omit for a page type. */
  readonly patterns?: readonly string[]
  /** `extension` outranks `builtin` and may take over a builtin kind. */
  readonly priority?: 'extension' | 'builtin' | 'fallback'
  readonly canOpen?: (address: string) => boolean
  readonly title: (address: string) => string
  readonly guide?: readonly SidebarRightGuideEntryFace[]
}

/**
 * The right-Sidebar navigation face (`ctx.sidebarRight`). `openResource` is how
 * this plugin delegates file viewing to the product: the address names the file
 * and DSH's own document-preview tab renders it (including paths outside the
 * session workspace, through the `absolute` scope).
 */
export interface SidebarRightFace {
  /** Open a page type by kind (e.g. the built-in document preview). */
  openTab(kind: string, options?: unknown): void
  /** Open a `dsh-resource://` address. */
  openResource(address: string, options?: unknown): void
  isExpanded(): boolean
  toggleExpanded(): void
}

/** The 0.1.5 right-Sidebar tab-type registry (`ctx.sidebarRightTabs`). */
export interface SidebarRightTabsFace {
  register(definition: SidebarRightTabDefinitionFace): () => void
}

/**
 * The shape this plugin actually consumes, intersected with the vendored
 * cordis `Context` below (see the file header for why intersection is used
 * instead of module augmentation).
 */
export interface SidebarContextShape {
  /** The webServer service face this plugin uses. */
  webServer: SidebarWebServer
  /** The session store (host `.get`) and the client list feed (`.list`) faces. */
  sessions: SidebarSessionStore & SidebarSessionsService
  /** The web runtime trust list (bind-derived). */
  webRuntime: SidebarWebRuntime
  /** The client slot registry — how the tab body/title reach the Sidebar's seats. */
  slots: SidebarSlotsService
  /**
   * DSH 0.1.5+ built-in right-Sidebar tab-type registry. This is the plugin's
   * only surface: the operation space is one tab type inside the BUILT-IN
   * Sidebar. Optional so a host without it degrades to a no-op registration
   * instead of a mount failure.
   */
  sidebarRightTabs?: SidebarRightTabsFace
  /** The right-Sidebar navigation face (openResource delegates file viewing to DSH). */
  sidebarRight?: SidebarRightFace
  /** The invariant registry face. */
  invariants: SidebarInvariantsService
  /** The client locale service face. */
  locale: SidebarLocaleService
  /** The tool registry (dsh-tools) that makes the active space model-visible. */
  tools: SidebarToolsService
  /** The host session-persistence service (optional; cold-session reads). */
  sessionPersistence?: SidebarSessionPersistenceService
  /**
   * String-keyed session feed subscribe (the vendored cordis `on` is keyed
   * to its typed Events map; the harness session feed is a plain string
   * event). The listener receives every appended session event with the
   * LIVE Session instance that appended it.
   */
  on(event: string, listener: (session: unknown, event: SidebarSessionEvent) => void): () => void
}

/**
 * The Context this plugin sees: the vendored cordis Context intersected with
 * the structural service faces above. Re-exported from the package root so a
 * consumer can `import type { Context } from 'dsh-octopus-operation-space'`.
 */
export type Context = CordisContext & SidebarContextShape
