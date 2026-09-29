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
 * convenience shape: `effect` invokes the body and keeps its disposer,
 * `webServer.register` captures the route exactly as the host webserver does,
 * and `tools.register` captures the tool definition the host would publish to
 * the model (its handler is then called with a stub run context, which is the
 * only way to assert the one thing the model ever sees).
 */
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  Context,
  SidebarHttpRequest,
  SidebarHttpResponse,
  SidebarSessionEvent,
  SidebarToolDefinition,
  SidebarToolRunContext,
  SidebarWebRoute,
} from '../src/context-types.ts'
import { API_PREFIX, apply } from '../src/index.ts'

/** The one session id the fake store knows; any other id is a cold session. */
const SESSION = 'sess-routes'

/**
 * The manifest every case starts from: one declared root written as the string
 * shorthand, with no access label, so it takes the security default (readOnly)
 * plus the implicit readWrite cwd root the policy appends.
 */
const DEFAULT_MANIFEST = JSON.stringify({ name: 'routes', folders: [{ path: '../ro' }] })

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
  await writeFile(manifestPath, DEFAULT_MANIFEST, 'utf8')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The mounted host half: the captured route plus the live event-log array. */
interface Harness {
  route: SidebarWebRoute
  /** Every tool definition the plugin registered (the model-visible surface). */
  tools: SidebarToolDefinition[]
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
  const tools: SidebarToolDefinition[] = []
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
    tools: {
      register(definition: SidebarToolDefinition): () => void {
        tools.push(definition)
        return () => { /* the fake owns teardown */ }
      },
    },
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
    tools,
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

/** Read the `error.message` field of a failure envelope (the operator-facing text). */
function errorMessage(reply: Reply): string {
  const body = reply.body as { ok: boolean; error: { message: string } }
  expect(body.ok).toBe(false)
  return body.error.message
}

/** Activate the fixture manifest for the live session. */
async function activate(harness: Harness): Promise<Record<string, unknown>> {
  const reply = await send(harness.route, {
    method: 'workspace.activate',
    body: JSON.stringify({ sessionId: SESSION, path: manifestPath }),
  })
  return value(reply).workspace as Record<string, unknown>
}

/** Names of the sidecar backups sitting next to the fixture manifest. */
async function backups(): Promise<string[]> {
  return (await readdir(cwd)).filter(name => name.endsWith('.octopus-backup')).sort()
}

/** One root of a returned snapshot, located by its path. */
function rootAt(workspace: Record<string, unknown>, path: string): { access: string; label: string } {
  const roots = workspace.roots as Array<{ path: string; access: string; label: string }>
  const found = roots.find(candidate => candidate.path === path)
  expect(found, `no root at "${path}" in ${JSON.stringify(roots)}`).toBeDefined()
  return found!
}

/**
 * One root of a returned snapshot by path, or undefined when the snapshot no
 * longer carries it — which is the shape a removal has to answer for.
 * @param workspace - the snapshot a write route returned.
 * @param path - the exact path to look for.
 * @returns the root view, or undefined when the path is no longer a root.
 */
function rootByPath(
  workspace: Record<string, unknown>,
  path: string,
): { path: string; listed: boolean; access: string } | undefined {
  return (workspace.roots as Array<{ path: string; listed: boolean; access: string }>)
    .find(candidate => candidate.path === path)
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

/**
 * The second write point in the plugin, reached from a row's padlock: one
 * declared root's access level, rewritten in the very manifest the session
 * activated. Everything here is asserted on the HTTP answer and on the file
 * bytes, because those are the two things an operator can observe: the answer
 * decides what the row draws, and the bytes decide what the NEXT activation
 * will enforce.
 */
describe('host route folder access (the padlock write point)', () => {
  /**
   * The shape a padlock change leaves behind: an object entry that already
   * carries an EXPLICIT level. A flip is then a one-token edit, so "everything
   * else is byte-identical" is checkable without re-deriving the editor's
   * insertion text here.
   */
  const EXPLICIT_MANIFEST = [
    '{',
    '  // the guarded root stays read-only until the operator says otherwise',
    '  "name": "routes",',
    '  "folders": [',
    '    { "path": "../ro", "access": "readOnly" } // keep this note a comment',
    '  ]',
    '}',
    '',
  ].join('\n')

  /**
   * The shorthand fixture: a bare string entry, no object to add a member to.
   * The path is absolute and spelled with forward slashes, exactly the form a
   * hand-written manifest on Windows tends to carry.
   * @param path - the absolute folder the entry names.
   * @returns the manifest text.
   */
  function shorthandManifest(path: string): string {
    const token = JSON.stringify(path.replace(/\\/g, '/'))
    return [
      '{',
      '  "name": "routes",',
      '  "folders": [',
      `    ${token} // the guarded root, read-only by default`,
      '  ]',
      '}',
      '',
    ].join('\n')
  }

  /** One padlock request through the mounted route. */
  function ask(harness: Harness, body: Record<string, unknown>): Promise<Reply> {
    return send(harness.route, {
      method: 'workspace.setFolderAccess',
      body: JSON.stringify({ sessionId: SESSION, ...body }),
    })
  }

  it('refuses the write while no operation space is active', async () => {
    const reply = await ask(mount(), { path: roRoot, access: 'readWrite' })
    expect(reply.status).toBe(403)
    expect(errorCode(reply)).toBe('forbidden')
    expect(errorMessage(reply)).toContain('no operation space is active')
    expect(await backups()).toEqual([])
  })

  it('refuses an unknown access level, and a missing one, before reading the manifest', async () => {
    const harness = mount()
    await activate(harness)
    const unknown = await ask(harness, { path: roRoot, access: 'sideways' })
    expect(unknown.status).toBe(400)
    expect(errorCode(unknown)).toBe('bad-request')
    expect(errorMessage(unknown)).toBe('unknown access "sideways"')
    // A missing `access` is NOT "readOnly by default" on this route: the padlock
    // always names the level it wants, so an absent one is the same refusal.
    const missing = await ask(harness, { path: roRoot })
    expect(missing.status).toBe(400)
    expect(errorCode(missing)).toBe('bad-request')
    expect(errorMessage(missing)).toBe('unknown access "undefined"')
    expect(await readFile(manifestPath, 'utf8')).toBe(DEFAULT_MANIFEST)
    expect(await backups()).toEqual([])
  })

  it('refuses a path that is no root of the active space', async () => {
    const harness = mount()
    await activate(harness)
    const outside = join(root, 'outside')
    await mkdir(outside)
    const notARoot = await ask(harness, { path: outside, access: 'readWrite' })
    expect(notARoot.status).toBe(400)
    expect(errorCode(notARoot)).toBe('bad-request')
    expect(errorMessage(notARoot)).toBe(`"${outside}" is not a root of the active operation space`)
    // INSIDE the space but not a root of its own: still not a root, still refused,
    // and still nothing written — the route never guesses at a parent entry.
    const child = await ask(harness, { path: join(roRoot, 'guarded.txt'), access: 'readWrite' })
    expect(child.status).toBe(400)
    expect(errorCode(child)).toBe('bad-request')
    expect(await readFile(manifestPath, 'utf8')).toBe(DEFAULT_MANIFEST)
    expect(await backups()).toEqual([])
  })

  it('refuses the session cwd, the implicit root the manifest does not declare', async () => {
    const harness = mount()
    const workspace = await activate(harness)
    const implicit = (workspace.roots as Array<{ path: string; listed: boolean }>)
      .find(candidate => !candidate.listed)!
    // It IS a root of the active space, so the refusal must be the other one: there
    // is no manifest entry that could persist a level for it. Asking for the level
    // it already has changes nothing about that.
    const reply = await ask(harness, { path: implicit.path, access: 'readOnly' })
    expect(reply.status).toBe(400)
    expect(errorCode(reply)).toBe('bad-request')
    expect(errorMessage(reply)).toBe(`"${implicit.path}" is not declared in the manifest`)
    expect(await readFile(manifestPath, 'utf8')).toBe(DEFAULT_MANIFEST)
    expect(await backups()).toEqual([])
  })

  it('flips a declared read-only root to readWrite, editing exactly one token', async () => {
    await writeFile(manifestPath, EXPLICIT_MANIFEST, 'utf8')
    const harness = mount()
    await activate(harness)

    const answer = value(await ask(harness, { path: roRoot, access: 'readWrite' }))
    expect(answer.changed).toBe(true)
    expect(answer.label).toBe('ro')

    // The sidecar the answer names is real, sits next to the manifest, and holds the
    // manifest AS IT WAS — the undo an operator would reach for.
    const backup = answer.backup as string
    expect(basename(backup).startsWith('ops.dsh-octopus.')).toBe(true)
    expect(await backups()).toContain(basename(backup))
    expect(await readFile(backup, 'utf8')).toBe(EXPLICIT_MANIFEST)

    // One literal moved; put it back and the file is byte-identical again, comments
    // (and their lines) included.
    const after = await readFile(manifestPath, 'utf8')
    expect(after).toContain('"access": "readWrite"')
    expect(after.replace('"access": "readWrite"', '"access": "readOnly"')).toBe(EXPLICIT_MANIFEST)
    expect(after).toContain('// keep this note a comment')
    expect(after).toContain('// the guarded root stays read-only until the operator says otherwise')

    // The snapshot the answer carries already reports the new level, so the row's
    // padlock and the write fence both follow the file without a restart.
    expect(rootAt(answer.workspace as Record<string, unknown>, roRoot).access).toBe('readWrite')
  })

  it('flips it back, so the round trip returns the original bytes', async () => {
    await writeFile(manifestPath, EXPLICIT_MANIFEST, 'utf8')
    const harness = mount()
    await activate(harness)

    expect(value(await ask(harness, { path: roRoot, access: 'readWrite' })).changed).toBe(true)
    const back = value(await ask(harness, { path: roRoot, access: 'readOnly' }))
    expect(back.changed).toBe(true)
    expect(back.label).toBe('ro')
    expect(await readFile(manifestPath, 'utf8')).toBe(EXPLICIT_MANIFEST)
    expect(rootAt(back.workspace as Record<string, unknown>, roRoot).access).toBe('readOnly')
  })

  it('answers changed:false — no write, no backup — when the entry already declares that level', async () => {
    await writeFile(manifestPath, EXPLICIT_MANIFEST, 'utf8')
    const harness = mount()
    await activate(harness)

    // The manifest already declares readOnly, so the very first request is a no-op:
    // no sidecar is left next to an untouched file.
    const same = value(await ask(harness, { path: roRoot, access: 'readOnly' }))
    expect(same.changed).toBe(false)
    expect(same.label).toBe('ro')
    expect(same.backup).toBeUndefined()
    expect(await readFile(manifestPath, 'utf8')).toBe(EXPLICIT_MANIFEST)
    expect(await backups()).toEqual([])

    // And after a real flip, repeating that level must move neither the file nor
    // the set of sidecars.
    expect(value(await ask(harness, { path: roRoot, access: 'readWrite' })).changed).toBe(true)
    const flipped = await readFile(manifestPath, 'utf8')
    const sidecars = await backups()
    const again = value(await ask(harness, { path: roRoot, access: 'readWrite' }))
    expect(again.changed).toBe(false)
    expect(again.label).toBe('ro')
    expect(again.backup).toBeUndefined()
    expect(await readFile(manifestPath, 'utf8')).toBe(flipped)
    expect(await backups()).toEqual(sidecars)
  })

  it('turns a string-shorthand entry into the object form, token verbatim', async () => {
    const before = shorthandManifest(roRoot)
    const token = JSON.stringify(roRoot.replace(/\\/g, '/'))
    await writeFile(manifestPath, before, 'utf8')
    const harness = mount()
    const workspace = await activate(harness)
    // The shorthand carries no level, so it takes the security default first.
    expect(rootAt(workspace, roRoot).access).toBe('readOnly')

    const answer = value(await ask(harness, { path: roRoot, access: 'readWrite' }))
    expect(answer.changed).toBe(true)
    expect(answer.label).toBe('ro')

    const after = await readFile(manifestPath, 'utf8')
    expect(after).toContain(`{ "path": ${token}, "access": "readWrite" }`)
    // The rewrite is that one element and nothing else: the author's string token is
    // copied verbatim and the note on its line stays a comment.
    expect(after).toBe(before.replace(token, `{ "path": ${token}, "access": "readWrite" }`))
    expect(after).toContain('// the guarded root, read-only by default')
    expect(rootAt(answer.workspace as Record<string, unknown>, roRoot).access).toBe('readWrite')
  })

  it('matches a relative manifest entry from its absolute request', async () => {
    // The entry is written so that ONLY resolution makes it equal the request: the
    // raw token shares no prefix with the absolute path the snapshot reports. This is
    // precisely why the host resolves each entry with the policy's own rule instead
    // of comparing the request to the text.
    const relative = [
      '{',
      '  "folders": [ "../cwd/../ro" ]',
      '}',
      '',
    ].join('\n')
    await writeFile(manifestPath, relative, 'utf8')
    const harness = mount()
    const workspace = await activate(harness)
    expect(rootAt(workspace, roRoot).access).toBe('readOnly')

    const answer = value(await ask(harness, { path: roRoot, access: 'readWrite' }))
    expect(answer.changed).toBe(true)
    expect(answer.label).toBe('ro')

    const after = await readFile(manifestPath, 'utf8')
    expect(after).toContain('"../cwd/../ro"')
    // The entry keeps its own spelling: the request never rewrites it.
    expect(after).not.toContain(roRoot)
    expect(rootAt(answer.workspace as Record<string, unknown>, roRoot).access).toBe('readWrite')
  })
})

/**
 * The third write point, reached from a row's context menu: one declaration is
 * DELETED from the manifest the session activated. The folder on disk is never
 * touched, so these cases assert on the HTTP answer and on the file bytes exactly
 * like the padlock block above — plus the one thing a removal can do that an
 * access flip cannot: leave the space with a different SET of roots (and, when the
 * removed entry was the session cwd itself, hand that path back as the implicit
 * readWrite root the policy appends).
 */
describe('host route folder removal (the context-menu write point)', () => {
  /**
   * Two declared roots on their own lines, one of them with a note. This is the
   * shape a removal has to give back byte for byte: the deleted entry leaves with
   * exactly one separator comma and its own line's note, the survivor is untouched,
   * and the array stays a non-empty, parseable `folders`.
   */
  const TWO_ROOTS_MANIFEST = [
    '{',
    '  // the guarded root leaves first',
    '  "name": "routes",',
    '  "folders": [',
    '    { "path": "../ro" }, // the one that goes',
    '    { "path": "../keep", "access": "readWrite" }',
    '  ]',
    '}',
    '',
  ].join('\n')

  /** The same document after the FIRST entry (and its line) is gone. */
  const TWO_ROOTS_AFTER_FIRST = [
    '{',
    '  // the guarded root leaves first',
    '  "name": "routes",',
    '  "folders": [',
    '    { "path": "../keep", "access": "readWrite" }',
    '  ]',
    '}',
    '',
  ].join('\n')

  /**
   * The same document after the LAST entry is gone instead. Only the separator
   * comma in front of it may move: the first entry and its note stay exactly where
   * the author put them.
   */
  const TWO_ROOTS_AFTER_LAST = [
    '{',
    '  // the guarded root leaves first',
    '  "name": "routes",',
    '  "folders": [',
    '    { "path": "../ro" } // the one that goes',
    '  ]',
    '}',
    '',
  ].join('\n')

  /**
   * The session cwd declared by hand next to another root. Removing that entry must
   * NOT lose the folder: with no declaration left to claim it, the policy appends
   * its own implicit readWrite cwd root.
   */
  const CWD_DECLARED_MANIFEST = [
    '{',
    '  "name": "routes",',
    '  "folders": [',
    '    ".", // the session cwd, declared by hand',
    '    { "path": "../ro", "access": "readOnly" }',
    '  ]',
    '}',
    '',
  ].join('\n')

  /** That document after the hand-written cwd entry is gone. */
  const CWD_DECLARED_AFTER = [
    '{',
    '  "name": "routes",',
    '  "folders": [',
    '    { "path": "../ro", "access": "readOnly" }',
    '  ]',
    '}',
    '',
  ].join('\n')

  /**
   * The two-root fixture as a shorthand entry plus an object survivor: a bare
   * string element has no members to edit, so a removal has to take the element
   * AND its separator comma.
   * @param path - the absolute folder the shorthand entry names.
   * @returns the manifest text.
   */
  function shorthandAndSurvivor(path: string): string {
    const token = JSON.stringify(path.replace(/\\/g, '/'))
    return [
      '{',
      '  "name": "routes",',
      '  "folders": [',
      `    ${token}, // the guarded root, read-only by default`,
      '    "../keep" // the survivor',
      '  ]',
      '}',
      '',
    ].join('\n')
  }

  /** The shorthand fixture after the bare string entry and its comma are gone. */
  const SHORTHAND_AFTER = [
    '{',
    '  "name": "routes",',
    '  "folders": [',
    '    "../keep" // the survivor',
    '  ]',
    '}',
    '',
  ].join('\n')

  /** One removal request through the mounted route. */
  function removeFolder(harness: Harness, body: Record<string, unknown>): Promise<Reply> {
    return send(harness.route, {
      method: 'workspace.removeFolder',
      body: JSON.stringify({ sessionId: SESSION, ...body }),
    })
  }

  /** The two-root fixture on disk, with the folder its survivor entry names. */
  async function twoRoots(): Promise<string> {
    const keepRoot = join(root, 'keep')
    await mkdir(keepRoot)
    await writeFile(manifestPath, TWO_ROOTS_MANIFEST, 'utf8')
    return keepRoot
  }

  it('refuses the removal while no operation space is active', async () => {
    const reply = await removeFolder(mount(), { path: roRoot })
    expect(reply.status).toBe(403)
    expect(errorCode(reply)).toBe('forbidden')
    expect(errorMessage(reply)).toContain('no operation space is active')
    expect(await readFile(manifestPath, 'utf8')).toBe(DEFAULT_MANIFEST)
    expect(await backups()).toEqual([])
  })

  it('refuses a path that is no root of the active space', async () => {
    const harness = mount()
    await activate(harness)
    const outside = join(root, 'outside')
    await mkdir(outside)
    const notARoot = await removeFolder(harness, { path: outside })
    expect(notARoot.status).toBe(400)
    expect(errorCode(notARoot)).toBe('bad-request')
    expect(errorMessage(notARoot)).toBe(`"${outside}" is not a root of the active operation space`)
    // Inside the space but not a root of its own: still not a root, still refused,
    // and still nothing written — a removal never guesses at a parent entry.
    const child = await removeFolder(harness, { path: join(roRoot, 'guarded.txt') })
    expect(child.status).toBe(400)
    expect(errorCode(child)).toBe('bad-request')
    expect(errorMessage(child)).toContain('is not a root of the active operation space')
    expect(await readFile(manifestPath, 'utf8')).toBe(DEFAULT_MANIFEST)
    expect(await backups()).toEqual([])
  })

  it('refuses the session cwd, the implicit root the manifest does not declare', async () => {
    const harness = mount()
    const workspace = await activate(harness)
    const implicit = (workspace.roots as Array<{ path: string; listed: boolean }>)
      .find(candidate => !candidate.listed)!
    // It IS a root of the active space, so the refusal must be the other one: there
    // is no manifest entry that could be deleted for it. The schema has no way to
    // say "not this folder", which makes this refusal permanent by design.
    const reply = await removeFolder(harness, { path: implicit.path })
    expect(reply.status).toBe(400)
    expect(errorCode(reply)).toBe('bad-request')
    expect(errorMessage(reply)).toBe(`"${implicit.path}" is not declared in the manifest`)
    expect(await readFile(manifestPath, 'utf8')).toBe(DEFAULT_MANIFEST)
    expect(await backups()).toEqual([])
  })

  it('deletes a declared entry and nothing else, byte for byte', async () => {
    const keepRoot = await twoRoots()
    const harness = mount()
    await activate(harness)

    const answer = value(await removeFolder(harness, { path: roRoot }))
    expect(answer.changed).toBe(true)
    expect(answer.label).toBe('ro')

    // The sidecar the answer names is real, sits next to the manifest, and holds the
    // manifest AS IT WAS — the undo an operator would reach for.
    const backup = answer.backup as string
    expect(basename(backup).startsWith('ops.dsh-octopus.')).toBe(true)
    expect(await backups()).toContain(basename(backup))
    expect(await readFile(backup, 'utf8')).toBe(TWO_ROOTS_MANIFEST)

    // Exactly one entry and its own line's note left; the survivor's line and the
    // note above the array are byte-identical.
    expect(await readFile(manifestPath, 'utf8')).toBe(TWO_ROOTS_AFTER_FIRST)

    const workspace = answer.workspace as Record<string, unknown>
    // The snapshot the answer carries no longer has that root, and the other one is
    // still there with the level the manifest declares.
    expect(rootByPath(workspace, roRoot)).toBeUndefined()
    expect(rootAt(workspace, keepRoot).access).toBe('readWrite')
    expect(workspace.name).toBe('routes')
    expect((workspace.roots as Array<{ listed: boolean }>).some(candidate => !candidate.listed)).toBe(true)

    // The declaration is gone; the FOLDER is not. Nothing in this route touches disk
    // except the manifest itself.
    expect(await readFile(join(roRoot, 'guarded.txt'), 'utf8')).toBe('original')
  })

  it('re-activates with the ORIGINAL activatedAt, so the violation floor cannot move', async () => {
    await twoRoots()
    const harness = mount()
    const before = await activate(harness)

    const answer = value(await removeFolder(harness, { path: roRoot }))
    const after = answer.workspace as Record<string, unknown>

    // The manifest really was re-read (one fewer root), and yet the timestamp the
    // violation scan uses as its lower bound is the one activation set.
    expect((after.roots as unknown[]).length).toBe((before.roots as unknown[]).length - 1)
    expect(after.activatedAt).toBe(before.activatedAt)
  })

  it('hands the removed path back as the implicit readWrite root when it was the cwd', async () => {
    await writeFile(manifestPath, CWD_DECLARED_MANIFEST, 'utf8')
    const harness = mount()
    const workspace = await activate(harness)
    // While the entry is there, the manifest's own level governs the cwd (no level
    // written => the security default) and nothing else claims it.
    expect(rootByPath(workspace, cwd)).toMatchObject({ listed: true, access: 'readOnly' })

    const answer = value(await removeFolder(harness, { path: cwd }))
    expect(answer.changed).toBe(true)
    expect(answer.label).toBe('cwd')
    expect(await readFile(manifestPath, 'utf8')).toBe(CWD_DECLARED_AFTER)

    // The notice-worthy fact: the path is STILL in the operation space. With no
    // declaration claiming it any more, the policy appends its implicit cwd root —
    // now readWrite, because that is what an implicit root always is. So a removal
    // of the cwd itself does not remove that folder from the space, and the client
    // must not say that it did.
    const snapshot = answer.workspace as Record<string, unknown>
    const implicit = rootByPath(snapshot, cwd)
    expect(implicit).toEqual({ path: cwd, label: 'cwd', access: 'readWrite', exists: true, listed: false })
    // The other declared root survived, so the space is the same size it was.
    expect((snapshot.roots as unknown[]).length).toBe((workspace.roots as unknown[]).length)
    expect(rootAt(snapshot, roRoot).access).toBe('readOnly')
  })

  it('removes the last entry of the array while another declaration survives', async () => {
    const keepRoot = await twoRoots()
    const harness = mount()
    await activate(harness)

    const answer = value(await removeFolder(harness, { path: keepRoot }))
    expect(answer.changed).toBe(true)
    expect(answer.label).toBe('keep')
    // The separator comma in front of the last entry went with it; nothing dangles.
    expect(await readFile(manifestPath, 'utf8')).toBe(TWO_ROOTS_AFTER_LAST)

    const workspace = answer.workspace as Record<string, unknown>
    // The space is still the space it was: same name, same declared survivor, and the
    // implicit cwd root still rides along — so it never ends up rootless.
    expect(workspace.name).toBe('routes')
    expect(rootByPath(workspace, keepRoot)).toBeUndefined()
    expect(rootAt(workspace, roRoot).access).toBe('readOnly')
    expect((workspace.roots as Array<{ path: string }>).map(candidate => candidate.path).sort())
      .toEqual([cwd, roRoot].sort())
    expect((workspace.roots as Array<{ path: string; listed: boolean }>)
      .filter(candidate => !candidate.listed).map(candidate => candidate.path)).toEqual([cwd])
  })

  it('refuses to empty the array: the only declared folder cannot be removed', async () => {
    const harness = mount()
    await activate(harness)
    const before = (await readFile(manifestPath)).toString('utf8')

    // The fixture declares exactly ONE root, so dropping it would leave
    // `"folders": []` — which the product's own schema refuses (workspace-schema.ts:
    // `"folders"` must be a non-empty array). manifest-edit.ts owns the wording; what
    // this route guarantees is the reason and the fact that NOTHING happened: the
    // refusal is taken BEFORE the transaction opens, so there is no write, no
    // temporary file and no sidecar behind it.
    const reply = await removeFolder(harness, { path: roRoot })
    expect(reply.status).toBe(400)
    expect(errorCode(reply)).toBe('bad-request')
    expect(errorMessage(reply)).toMatch(/only declared folder/)

    // Byte-identical, no sidecar, and the session's space is untouched: still active,
    // still the same roots.
    expect(await readFile(manifestPath, 'utf8')).toBe(before)
    expect(await backups()).toEqual([])
    // Nor the temporary file a transaction would have written: the refusal never
    // opened one.
    expect((await readdir(cwd)).filter(name => name.includes('.octopus-edit-'))).toEqual([])
    const state = value(await send(harness.route, { body: JSON.stringify({ sessionId: SESSION }) }))
    const workspace = state.workspace as Record<string, unknown>
    expect(workspace).not.toBeNull()
    expect(workspace.name).toBe('routes')
    expect((workspace.roots as Array<{ path: string }>).map(candidate => candidate.path)).toEqual([roRoot, cwd])
  })

  it('answers "is not a root" on a second removal of the same path', async () => {
    await twoRoots()
    const harness = mount()
    await activate(harness)
    expect(value(await removeFolder(harness, { path: roRoot })).changed).toBe(true)

    const sidecars = await backups()
    const text = await readFile(manifestPath, 'utf8')
    // The root is gone from the space, so the same request is now the plain
    // "no such root" refusal — and a stale row cannot delete a second entry.
    const again = await removeFolder(harness, { path: roRoot })
    expect(again.status).toBe(400)
    expect(errorCode(again)).toBe('bad-request')
    expect(errorMessage(again)).toBe(`"${roRoot}" is not a root of the active operation space`)
    expect(await readFile(manifestPath, 'utf8')).toBe(text)
    expect(await backups()).toEqual(sidecars)
  })

  it('deletes a bare string-shorthand entry together with its comma', async () => {
    const keepRoot = join(root, 'keep')
    await mkdir(keepRoot)
    const before = shorthandAndSurvivor(roRoot)
    const token = JSON.stringify(roRoot.replace(/\\/g, '/'))
    await writeFile(manifestPath, before, 'utf8')
    const harness = mount()
    // The shorthand carries no level, so it takes the security default first.
    expect(rootAt(await activate(harness), roRoot).access).toBe('readOnly')

    const answer = value(await removeFolder(harness, { path: roRoot }))
    expect(answer.changed).toBe(true)
    expect(answer.label).toBe('ro')

    const after = await readFile(manifestPath, 'utf8')
    // The bare element is gone with exactly one separator comma: the survivor is
    // still an element of the array, and no `,,` was left behind.
    expect(after).toBe(SHORTHAND_AFTER)
    expect(after).not.toContain(token)
    expect(after).not.toContain(',,')

    const workspace = answer.workspace as Record<string, unknown>
    expect(rootByPath(workspace, roRoot)).toBeUndefined()
    expect(rootAt(workspace, keepRoot).access).toBe('readOnly')
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

describe('host route desktop handoff', () => {
  it('reports whether this host has a desktop file manager at all', async () => {
    const harness = mount()
    const details = value(await send(harness.route, {
      method: 'workspace.state',
      body: JSON.stringify({ sessionId: SESSION }),
    }))
    // The three supported desktops answer true. The field exists so a host
    // WITHOUT one hides the row action instead of offering a doomed button.
    expect(typeof details.canReveal).toBe('boolean')
    if (process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux') {
      expect(details.canReveal).toBe(true)
    }
  })

  it('refuses a reveal while no operation space is active', async () => {
    const harness = mount()
    const reply = await send(harness.route, {
      method: 'workspace.reveal',
      body: JSON.stringify({ sessionId: SESSION, path: cwd }),
    })
    expect(reply.status).toBe(403)
    expect(errorCode(reply)).toBe('forbidden')
  })

  it('refuses a path outside every declared root', async () => {
    const harness = mount()
    await activate(harness)
    const outside = join(root, 'outside')
    await mkdir(outside)
    const reply = await send(harness.route, {
      method: 'workspace.reveal',
      body: JSON.stringify({ sessionId: SESSION, path: outside }),
    })
    expect(reply.status).toBe(403)
    expect(errorCode(reply)).toBe('forbidden')
  })

  it('refuses a missing path inside the space rather than launching anything', async () => {
    const harness = mount()
    await activate(harness)
    const reply = await send(harness.route, {
      method: 'workspace.reveal',
      body: JSON.stringify({ sessionId: SESSION, path: join(roRoot, 'never-existed.txt') }),
    })
    expect(reply.status).toBe(400)
  })

  // The SUCCESS path is deliberately absent here: it would open a real window on
  // the machine running the suite. Its two halves are covered instead —
  // `native-reveal.spec.ts` pins the exact argv per platform, and the launched
  // handoff is verified by hand once per change (and never in the smoke script,
  // which would pop windows on a machine nobody is watching).
})

describe('model-visible operation space tool', () => {
  /** The stub run context a tool handler receives (shape per dsh-tools). */
  const execFor = (sessionId: string): SidebarToolRunContext => ({
    agent: { session: { id: sessionId } },
    signal: new AbortController().signal,
  })

  it('registers exactly one tool whose projection states the label-to-path contract', async () => {
    const harness = mount()
    expect(harness.tools.map(tool => tool.name)).toEqual(['octopus_space'])
    const tool = harness.tools[0]!
    // The description is the model's ENTIRE contract — nothing else of the
    // definition reaches the wire (the runtime whitelists name/description/
    // parameters), so an empty or silent one would leave the tool unreachable
    // in practice even though it is registered.
    expect(tool.description).toContain('章鱼作业区')
    expect(tool.description).toContain('LABEL')
    expect(tool.description).toContain('read-only')
    expect(tool.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false })
    // A definition without `output` never registers; both halves must exist.
    expect(tool.output.schema).toEqual({ type: 'string' })
    expect(tool.output.render({}, 'payload')).toEqual([{ type: 'text', text: 'payload' }])
  })

  it('says no space is active instead of inventing one, then reports roots with labels and access', async () => {
    const harness = mount()
    const tool = harness.tools[0]!
    const exec = execFor(SESSION)

    // Before activation the answer is a sentence the model can act on (where a
    // space comes from), not `active: false` plus a session id it cannot use.
    // The exact wording is pinned in `workspace-report.spec.ts`; what matters
    // HERE is that the tool really routes through that module.
    const before = String(await tool.execute({}, exec))
    expect(before).toContain('No operation space is active')
    expect(before).toContain('.dsh-octopus')
    expect(before).not.toContain('{')

    // `activate` resolves to the activated snapshot itself (see the lifecycle
    // tests above); the tool must then report exactly that space.
    await activate(harness)
    const report = String(await tool.execute({}, exec))
    expect(report).toContain(`Manifest: ${manifestPath}`)

    // The whole point of the tool: the label the user typed resolves to the
    // absolute path the manifest granted, under the access the manifest declared
    // — stated once per group instead of once per root.
    expect(report).toContain('read-only (')
    expect(report).toContain(`  ro = ${roRoot}`)
    // The session cwd rides along as the implicit readWrite root, so the model
    // also learns the one folder it is allowed to write without being told, and
    // that no manifest entry declares it (`implicit`).
    expect(report).toContain('read-write (')
    expect(report).toContain('(implicit)')

    // What the model is NOT charged for: the wire snapshot's own fields.
    expect(report).not.toContain('sessionId')
    expect(report).not.toContain('activatedAt')
    expect(report).not.toContain('"access"')
  })

  it('fails loudly when the call has no owning session rather than answering for another one', async () => {
    const harness = mount()
    const tool = harness.tools[0]!
    await expect(tool.execute({}, { signal: new AbortController().signal }))
      .rejects.toThrow('needs the calling session')
  })
})
