/**
 * End-to-end tests for the host half's ONLY route: `POST /octopus/api/<method>`
 * (a single `prefix` route). These drive the real `apply()` through a fake
 * cordis context and a fake node request/response pair, so everything the
 * plugin actually does between the wire and the filesystem is exercised:
 * the trust fence, method dispatch, the error envelopes, the operation-space
 * lifecycle, the root fence, and the read-only write report plus its rollback.
 *
 * Why route-level rather than only unit-level: until now the plugin's active
 * surface (this route, the workspace lifecycle, the read-only report) was
 * covered at the unit level (workspace-policy.spec.ts) and by a manual mount
 * smoke — but a wiring mistake in the route table, the fence order, or the
 * dispatch would have passed both. These tests mount for real and speak HTTP.
 *
 * The fake context deliberately mirrors the runtime contract rather than a
 * convenience shape: `effect` invokes the body and keeps its disposer, and
 * `webServer.register` captures the route exactly as the host webserver does.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  Context,
  SidebarHttpRequest,
  SidebarHttpResponse,
  SidebarSessionEvent,
  SidebarWebRoute,
} from '../src/context-types.ts'
import { API_PREFIX, apply } from '../src/index.ts'

/** The one session id the fake store knows; any other id is a cold session. */
const SESSION = 'sess-routes'

let root: string
let cwd: string
let roRoot: string
let manifestPath: string

beforeEach(async () => {
  // realpath up front: the plugin canonicalizes its roots, and on Windows a
  // temp path can be served through a short (8.3) form that would not compare
  // equal to the literal join below.
  root = await realpath(await mkdtemp(join(tmpdir(), 'octopus-routes-')))
  cwd = join(root, 'cwd')
  roRoot = join(root, 'ro')
  await mkdir(cwd)
  await mkdir(roRoot)
  await writeFile(join(roRoot, 'guarded.txt'), 'original', 'utf8')
  await writeFile(join(cwd, 'work.txt'), 'w', 'utf8')
  // 'ro' carries no access label => it defaults to readOnly (the security default).
  manifestPath = join(cwd, 'ops.dsh-octopus')
  await writeFile(manifestPath, JSON.stringify({ name: 'routes', folders: [{ path: '../ro' }] }), 'utf8')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The mounted host half: the captured route plus the live event-log array. */
interface Harness {
  route: SidebarWebRoute
  /** Mutate AFTER activation to simulate writes the host session log records. */
  events: SidebarSessionEvent[]
  /** Everything the plugin logged (the fake captures `ctx.logger.info/warn`). */
  logs: string[]
  dispose: () => void
}

/** The host session-persistence face the plugin probes for cold sessions. */
interface PersistenceFake {
  stat(id: string): Promise<{ header: { cwd?: string } } | undefined>
  open(id: string, access: 'read' | 'write'): Promise<unknown>
}

/** Options of a fake mount. */
interface MountOptions {
  /** Non-loopback authorities this deployment serves. */
  trustedHosts?: string[]
  /** The mutable session event log the fake store returns. */
  events?: SidebarSessionEvent[]
  /** The optional persistence service, when a case needs a cold session. */
  persistence?: PersistenceFake
}

/**
 * Mount the plugin on a fake context and return its captured route.
 * @param options - trust list, session event log, optional persistence service.
 * @returns the harness (route, event array, disposer).
 */
function mount(options: MountOptions = {}): Harness {
  const routes: SidebarWebRoute[] = []
  const disposers: Array<() => void> = []
  const logs: string[] = []
  const events = options.events ?? []
  const ctx = {
    webServer: {
      register(route: SidebarWebRoute): () => void {
        routes.push(route)
        return () => { /* the fake owns teardown */ }
      },
    },
    webRuntime: { trustedHosts: options.trustedHosts ?? [] },
    sessions: {
      get: (id: string) => (id === SESSION ? { header: { cwd }, snapshotEvents: () => events } : undefined),
    },
    logger: {
      info: (message: string) => { logs.push(`info: ${message}`) },
      warn: (message: string) => { logs.push(`warn: ${message}`) },
    },
    effect: (body: () => void | (() => void)): (() => void) => {
      const disposer = body()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => { /* the fake owns teardown */ }
    },
    // Optional-service probe: undefined means "this host has no such service".
    get: (name: string) => (name === 'sessionPersistence' ? options.persistence : undefined),
  } as unknown as Context
  apply(ctx)
  if (routes.length !== 1) throw new Error(`expected exactly one route, got ${routes.length}`)
  return {
    route: routes[0]!,
    events,
    logs,
    dispose: () => { for (const disposer of disposers) disposer() },
  }
}

/** One parsed reply from the route. */
interface Reply {
  status: number
  body: unknown
}

/** Build a fake node request whose async iteration yields the given body. */
function request(
  url: string,
  httpMethod: string,
  headers: Record<string, string>,
  body: string,
): SidebarHttpRequest {
  return {
    url,
    method: httpMethod,
    headers,
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      if (body !== '') yield Buffer.from(body, 'utf8')
    },
  } as unknown as SidebarHttpRequest
}

/** Send one request through the route and parse the reply. */
async function send(
  route: SidebarWebRoute,
  options: {
    method?: string
    path?: string
    httpMethod?: string
    body?: string
    headers?: Record<string, string>
  } = {},
): Promise<Reply> {
  const url = options.path ?? `${API_PREFIX}/${options.method ?? 'workspace.state'}`
  const headers = options.headers ?? { host: '127.0.0.1:3080' }
  const captured = { status: 0, payload: '' }
  const res: SidebarHttpResponse = {
    get statusCode(): number { return captured.status },
    set statusCode(value: number) { captured.status = value },
    writeHead(status: number): void { captured.status = status },
    end(payload?: string | Uint8Array): void {
      captured.payload = typeof payload === 'string'
        ? payload
        : Buffer.from(payload ?? new Uint8Array()).toString('utf8')
    },
  }
  await route.handler(request(url, options.httpMethod ?? 'POST', headers, options.body ?? '{}'), res)
  return { status: captured.status, body: captured.payload === '' ? undefined : JSON.parse(captured.payload) }
}

/** Read the `value` field of a success envelope. */
function value(reply: Reply): Record<string, unknown> {
  expect(reply.status).toBe(200)
  const body = reply.body as { ok: boolean; value: Record<string, unknown> }
  expect(body.ok).toBe(true)
  return body.value
}

/** Read the `error.code` field of a failure envelope. */
function errorCode(reply: Reply): string {
  const body = reply.body as { ok: boolean; error: { code: string } }
  expect(body.ok).toBe(false)
  return body.error.code
}

/** Activate the fixture manifest for the live session. */
async function activate(harness: Harness): Promise<Record<string, unknown>> {
  const reply = await send(harness.route, {
    method: 'workspace.activate',
    body: JSON.stringify({ sessionId: SESSION, path: manifestPath }),
  })
  return value(reply).workspace as Record<string, unknown>
}

/** One session event (call or result) shaped as the host writes it. */
function callEvent(
  type: 'tool/call' | 'tool/result',
  callId: string,
  name: string,
  args: string | undefined,
  time: number,
): SidebarSessionEvent {
  return {
    type,
    seq: 0,
    time,
    data: type === 'tool/call'
      ? { name, callId, arguments: args ?? '{}' }
      : { message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', content: [] }] } },
  }
}

describe('host route mounting', () => {
  it('registers exactly one prefix route at the plugin prefix', () => {
    const harness = mount()
    expect(harness.route.kind).toBe('prefix')
    expect(harness.route.path).toBe(API_PREFIX)
    harness.dispose()
  })
})

describe('host route trust fence', () => {
  it('refuses a non-loopback, untrusted Host', async () => {
    const reply = await send(mount().route, { headers: { host: 'evil.example' } })
    expect(reply.status).toBe(403)
    expect(errorCode(reply)).toBe('forbidden')
  })

  it('refuses cross-site browser markers and a mismatched Origin', async () => {
    const crossSite = await send(mount().route, {
      headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
    })
    expect(crossSite.status).toBe(403)
    const badOrigin = await send(mount().route, {
      headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' },
    })
    expect(badOrigin.status).toBe(403)
  })

  it('accepts loopback, and a configured trusted authority', async () => {
    expect((await send(mount().route, { body: JSON.stringify({ sessionId: SESSION }) })).status).toBe(200)
    const trusted = mount({ trustedHosts: ['10.0.0.5:3080'] })
    const reply = await send(trusted.route, {
      headers: { host: '10.0.0.5:3080' },
      body: JSON.stringify({ sessionId: SESSION }),
    })
    expect(reply.status).toBe(200)
  })
})

describe('host route dispatch and envelopes', () => {
  it('rejects a non-POST method', async () => {
    const reply = await send(mount().route, { httpMethod: 'GET' })
    expect(reply.status).toBe(405)
    expect(errorCode(reply)).toBe('method-error')
  })

  it('answers unknown, empty and nested method segments with a plugin 404', async () => {
    const harness = mount()
    for (const path of [`${API_PREFIX}/nope`, `${API_PREFIX}/`, `${API_PREFIX}/a/b`]) {
      const reply = await send(harness.route, { path })
      expect(reply.status).toBe(404)
      expect(errorCode(reply)).toBe('not-found')
    }
  })

  it('rejects a malformed body and a missing required field', async () => {
    const harness = mount()
    const malformed = await send(harness.route, { body: 'not json' })
    expect(malformed.status).toBe(400)
    expect(errorCode(malformed)).toBe('bad-request')
    const missing = await send(harness.route, { method: 'workspace.state', body: '{}' })
    expect(missing.status).toBe(400)
    expect(errorCode(missing)).toBe('bad-request')
  })
})

describe('host route manifest discovery', () => {
  it('finds the manifest in the session cwd while NOTHING is active', async () => {
    const harness = mount()
    // Nothing is activated yet, so browsing is fenced on purpose — discovery
    // must not share that fence, because it is what makes activation possible.
    const fenced = await send(harness.route, {
      method: 'fs.tree',
      body: JSON.stringify({ sessionId: SESSION, path: cwd }),
    })
    expect(fenced.status).toBe(403)

    const found = value(await send(harness.route, {
      method: 'workspace.discover',
      body: JSON.stringify({ sessionId: SESSION }),
    }))
    expect(found.cwd).toBe(cwd)
    const candidates = found.candidates as Array<{ fileName: string; name: string; autoActivate: boolean; path: string }>
    expect(candidates.map(candidate => candidate.fileName)).toEqual(['ops.dsh-octopus'])
    expect(candidates[0]!.path).toBe(manifestPath)
    expect(candidates[0]!.name).toBe('routes')
    // No `settings.autoActivate` in the fixture => the documented default.
    expect(candidates[0]!.autoActivate).toBe(true)
  })

  it('surfaces an opt-out and an unparseable sibling instead of guessing', async () => {
    await writeFile(
      join(cwd, 'manual.dsh-octopus'),
      JSON.stringify({ folders: ['.'], settings: { autoActivate: false } }),
      'utf8',
    )
    await writeFile(join(cwd, 'broken.dsh-octopus'), '{ not json', 'utf8')
    const found = value(await send(mount().route, {
      method: 'workspace.discover',
      body: JSON.stringify({ sessionId: SESSION }),
    }))
    const candidates = found.candidates as Array<{ fileName: string; autoActivate: boolean; error?: string }>
    expect(candidates.map(candidate => candidate.fileName))
      .toEqual(['broken.dsh-octopus', 'manual.dsh-octopus', 'ops.dsh-octopus'])
    // The author's opt-out is reported, never overridden.
    expect(candidates.find(candidate => candidate.fileName === 'manual.dsh-octopus')!.autoActivate).toBe(false)
    // A file that cannot be parsed is still reported, with its reason.
    expect(candidates.find(candidate => candidate.fileName === 'broken.dsh-octopus')!.error).toBeTruthy()
  })

  it('uses the payload cwd for a cold session (the hydrating-client path)', async () => {
    const found = value(await send(mount().route, {
      method: 'workspace.discover',
      body: JSON.stringify({ sessionId: 'sess-cold', cwd }),
    }))
    expect((found.candidates as unknown[]).length).toBe(1)
  })

  it('answers an empty discovery for a missing folder rather than failing', async () => {
    const reply = await send(mount().route, {
      method: 'workspace.discover',
      body: JSON.stringify({ sessionId: 'sess-cold', cwd: join(root, 'no-such-folder') }),
    })
    expect(value(reply).candidates).toEqual([])
  })

  it('passes the same browser-trust fence as every other method', async () => {
    const reply = await send(mount().route, {
      method: 'workspace.discover',
      body: JSON.stringify({ sessionId: SESSION }),
      headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
    })
    expect(reply.status).toBe(403)
  })
})

describe('host route operation-space lifecycle', () => {
  it('reports no workspace before activation', async () => {
    const reply = await send(mount().route, { body: JSON.stringify({ sessionId: SESSION }) })
    expect(value(reply).workspace).toBeNull()
  })

  it('resolves the cwd from the session header, not the client payload', async () => {
    // The payload carries a deliberately wrong cwd: the header must win, or a
    // stale client could reclassify every real path as outside the space.
    const reply = await send(mount().route, {
      method: 'session.cwd',
      body: JSON.stringify({ sessionId: SESSION, cwd: 'C:\\somewhere-else' }),
    })
    expect(value(reply).cwd).toBe(cwd)
  })

  it('activates the manifest, lists a readOnly root, and refuses paths outside every root', async () => {
    const harness = mount()
    const workspace = await activate(harness)
    expect(workspace.name).toBe('routes')
    const roots = workspace.roots as Array<{ path: string; access: string; listed: boolean }>
    expect(roots.map(root => root.access)).toEqual(['readOnly', 'readWrite'])
    expect(roots[0]!.path).toBe(roRoot)
    expect(roots[1]!.listed).toBe(false) // the implicit cwd root

    // A readOnly root is still READABLE — that is the whole point of declaring it.
    const listing = value(await send(harness.route, {
      method: 'fs.tree',
      body: JSON.stringify({ sessionId: SESSION, path: roRoot }),
    }))
    expect((listing.entries as Array<{ name: string }>).map(entry => entry.name)).toEqual(['guarded.txt'])

    // The parent of every declared root is outside the space and must be refused
    // even though it exists and is a real directory.
    const outside = await send(harness.route, {
      method: 'fs.tree',
      body: JSON.stringify({ sessionId: SESSION, path: root }),
    })
    expect(outside.status).toBe(403)
    expect(errorCode(outside)).toBe('forbidden')
  })

  it('refuses every operation-space read while no space is active', async () => {
    const harness = mount()
    const reply = await send(harness.route, {
      method: 'fs.tree',
      body: JSON.stringify({ sessionId: SESSION, path: roRoot }),
    })
    expect(reply.status).toBe(403)
    expect(errorCode(reply)).toBe('forbidden')
  })

  it('deactivates back to no-workspace and re-fences the roots', async () => {
    const harness = mount()
    await activate(harness)
    expect(value(await send(harness.route, {
      method: 'workspace.deactivate',
      body: JSON.stringify({ sessionId: SESSION }),
    })).ok).toBe(true)
    expect(value(await send(harness.route, { body: JSON.stringify({ sessionId: SESSION }) })).workspace).toBeNull()
    const after = await send(harness.route, {
      method: 'fs.tree',
      body: JSON.stringify({ sessionId: SESSION, path: roRoot }),
    })
    expect(after.status).toBe(403)
  })

  it('rejects an unreadable manifest as a bad request', async () => {
    const harness = mount()
    const reply = await send(harness.route, {
      method: 'workspace.activate',
      body: JSON.stringify({ sessionId: SESSION, path: join(cwd, 'missing.dsh-octopus') }),
    })
    expect(reply.status).toBe(400)
    expect(errorCode(reply)).toBe('bad-request')
  })
})

describe('host route read-only write report', () => {
  it('reports a write into a readOnly root and rolls it back', async () => {
    const events: SidebarSessionEvent[] = []
    const harness = mount({ events })
    const workspace = await activate(harness)
    const activatedAt = workspace.activatedAt as number

    const guarded = join(roRoot, 'guarded.txt')
    // The intrusion really landed on disk, and the log records a prior write
    // BEFORE activation (the restore source) plus the intruding one after.
    await writeFile(guarded, 'intruder', 'utf8')
    events.push(
      callEvent('tool/call', 'c1', 'write', JSON.stringify({ file_path: '../ro/guarded.txt', content: 'original' }), activatedAt - 5_000),
      callEvent('tool/result', 'c1', 'write', undefined, activatedAt - 5_000),
      callEvent('tool/call', 'c2', 'write', JSON.stringify({ file_path: '../ro/guarded.txt', content: 'intruder' }), activatedAt + 1),
      callEvent('tool/result', 'c2', 'write', undefined, activatedAt + 1),
    )

    const report = value(await send(harness.route, {
      method: 'workspace.violations',
      body: JSON.stringify({ sessionId: SESSION }),
    }))
    const violations = report.violations as Array<{ callId: string; rootLabel: string; canRestore: boolean }>
    // Only the post-activation write is flagged; the earlier one is the source.
    expect(violations.map(violation => violation.callId)).toEqual(['c2'])
    expect(violations[0]!.rootLabel).toBe('ro')
    expect(violations[0]!.canRestore).toBe(true)

    const rollback = value(await send(harness.route, {
      method: 'workspace.rollback',
      body: JSON.stringify({ sessionId: SESSION, callId: 'c2' }),
    }))
    expect(rollback.ok).toBe(true)
    expect(await readFile(guarded, 'utf8')).toBe('original')
  })

  it('refuses a rollback when no space is active', async () => {
    const reply = await send(mount().route, {
      method: 'workspace.rollback',
      body: JSON.stringify({ sessionId: SESSION, callId: 'c1' }),
    })
    expect(reply.status).toBe(403)
    expect(errorCode(reply)).toBe('forbidden')
  })

  it('returns an empty report for a session with no active space', async () => {
    const reply = await send(mount().route, {
      method: 'workspace.violations',
      body: JSON.stringify({ sessionId: SESSION }),
    })
    expect(value(reply).violations).toEqual([])
  })
})

describe('host route cold sessions (the branch a real host broke)', () => {
  /** A persistence service with no record of any session. */
  const neverPersisted: PersistenceFake = {
    stat: async () => undefined,
    open: async () => { throw new Error('session not found') },
  }

  it('resolves a cold session cwd from the stored header', async () => {
    // Regression guard: this branch called `persistence.inspect()`, which DSH
    // 0.1.7 does not have, and answered HTTP 500 with
    // "persistence.inspect is not a function".
    const harness = mount({
      persistence: { stat: async () => ({ header: { cwd } }), open: neverPersisted.open },
    })
    const reply = await send(harness.route, {
      method: 'session.cwd',
      body: JSON.stringify({ sessionId: 'sess-cold' }),
    })
    expect(value(reply).cwd).toBe(cwd)
  })

  it('falls back to the host process cwd when nothing knows the session', async () => {
    const harness = mount({ persistence: neverPersisted })
    const reply = await send(harness.route, {
      method: 'session.cwd',
      body: JSON.stringify({ sessionId: 'sess-cold' }),
    })
    expect(value(reply).cwd).toBe(process.cwd())
  })

  it('folds a never-persisted log as an empty window, and says so in the log', async () => {
    // The event read goes through open()/read()/close(); not-found for a
    // never-persisted session is an ordinary empty window, not a failure. It
    // must not be SILENT either: an invisible degradation looks exactly like
    // "no writes happened", which is the one thing this report must not fake.
    const harness = mount({ persistence: neverPersisted })
    await send(harness.route, {
      method: 'workspace.activate',
      body: JSON.stringify({ sessionId: 'sess-cold', path: manifestPath, cwd }),
    })
    const report = value(await send(harness.route, {
      method: 'workspace.violations',
      body: JSON.stringify({ sessionId: 'sess-cold' }),
    }))
    expect(report.violations).toEqual([])
    expect(harness.logs.some(line => line.startsWith('warn:') && line.includes('violation report degraded'))).toBe(true)
  })

  it('folds a live session log without consulting persistence at all', async () => {
    const events: SidebarSessionEvent[] = []
    const harness = mount({
      events,
      persistence: {
        stat: async () => { throw new Error('stat must not be called for a live session') },
        open: async () => { throw new Error('open must not be called for a live session') },
      },
    })
    const workspace = await activate(harness)
    const activatedAt = workspace.activatedAt as number
    events.push(
      callEvent('tool/call', 'c9', 'write', JSON.stringify({ file_path: '../ro/guarded.txt', content: 'x' }), activatedAt + 1),
      callEvent('tool/result', 'c9', 'write', undefined, activatedAt + 1),
    )
    const report = value(await send(harness.route, {
      method: 'workspace.violations',
      body: JSON.stringify({ sessionId: SESSION }),
    }))
    expect((report.violations as Array<{ callId: string }>).map(violation => violation.callId)).toEqual(['c9'])
    expect(harness.logs.filter(line => line.includes('violation report degraded'))).toEqual([])
  })
})
