/**
 * The runtime-context contribution: the label table the model reads on EVERY turn.
 *
 * What is pinned here is the split the design rests on. The labels have to be in
 * front of the model before it can resolve a word like "VS调试", so they are
 * contributed as dynamic context — but the absolute paths deliberately are NOT,
 * because context is paid per assembly while a tool result is paid once. That
 * makes "does it leak a path?" a contract, not a detail, so it is asserted on a
 * real activated space rather than on a hand-built snapshot.
 *
 * The provider is called the way the service calls it: with that assembly's
 * `AssembleContext`, whose `agent` is absent on diagnostics. No session, no space,
 * no text — an empty contribution is how this stays free for sessions that never
 * apply one, and a registry read happens per call so a space applied later shows up
 * on the next turn rather than needing a remount.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { createSpaceContext, WORKSPACE_CONTEXT_NAME, WORKSPACE_CONTEXT_ORDER } from '../src/workspace-context.ts'
import { hostCaseInsensitive, WorkspaceRegistry } from '../src/workspace-state.ts'
import { WORKSPACE_TOOL_NAME } from '../src/workspace-tool.ts'

/** The session the fake registry activates; any other id has no space. */
const SESSION = 'sess-context'
/** A second session, to prove the contribution is keyed per session. */
const OTHER = 'sess-other'

let root: string
let cwd: string
let rwRoot: string
let roRoot: string
let manifestPath: string
let registry: WorkspaceRegistry

beforeEach(async () => {
  // realpath up front: the plugin canonicalizes its roots, and a Windows temp path
  // can be served through a short (8.3) form that would not compare equal.
  root = await realpath(await mkdtemp(join(tmpdir(), 'octopus-context-')))
  cwd = join(root, 'cwd')
  rwRoot = join(root, 'rw')
  roRoot = join(root, 'ro')
  await mkdir(cwd)
  await mkdir(rwRoot)
  await mkdir(roRoot)
  // One labeled read-write root and one unlabeled (=> security-default readOnly)
  // root, so both groups have a member.
  manifestPath = join(cwd, 'ops.dsh-octopus')
  await writeFile(manifestPath, JSON.stringify({
    name: 'ctx',
    folders: [{ path: '../rw', name: 'rw', access: 'readWrite' }, { path: '../ro', name: 'ro' }],
  }), 'utf8')
  registry = new WorkspaceRegistry(() => { /* silent: this is not what is under test */ })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * The assembly context the service would hand the provider for one session.
 * @param sessionId - the agent's session, or `undefined` for a diagnostics assembly.
 * @returns the assembly context (the `agent` field arrives via dsh-agent's merge
 *   extension of this interface, so the cast is the test standing in for it).
 */
function assembly(sessionId: string | undefined): AssembleContext {
  return sessionId === undefined
    ? {}
    : { agent: { session: { id: sessionId } } } as unknown as AssembleContext
}

/**
 * Resolve the contribution's text the way the service does.
 * @param contribution - the registered contribution.
 * @param sessionId - the session being assembled for, if any.
 * @returns the contributed text.
 */
function textFor(
  contribution: ReturnType<typeof createSpaceContext>,
  sessionId: string | undefined,
): string {
  const provider = contribution.text
  if (typeof provider !== 'function') throw new Error('the contribution must be a provider, not fixed text')
  return provider(assembly(sessionId))
}

describe('operation-space runtime context', () => {
  it('uses a stable name, and an order after the runtime policies', () => {
    const contribution = createSpaceContext(registry)
    expect(contribution.name).toBe(WORKSPACE_CONTEXT_NAME)
    expect(contribution.name).toBe('octopus-space')
    expect(contribution.order).toBe(WORKSPACE_CONTEXT_ORDER)
    // The service's own runtime contexts are 110 (sandbox policy), 115 (approval
    // policy), 120 (subagent delegation); the space says what the session may
    // touch at all, so it follows them instead of interleaving with policy.
    expect(WORKSPACE_CONTEXT_ORDER).toBeGreaterThan(120)
  })

  it('reports the labels of the active space and NO absolute path', async () => {
    await registry.activate(SESSION, manifestPath, cwd, hostCaseInsensitive())
    const text = textFor(createSpaceContext(registry), SESSION)
    expect(text).toContain('Operation space "ctx" is active in this session.')
    expect(text).toContain('read-write')
    expect(text).toContain('read-only')
    expect(text).toContain('rw')
    expect(text).toContain('ro')
    // The paths are the tool's job: paid once per call instead of once per turn.
    expect(text).not.toContain(rwRoot)
    expect(text).not.toContain(roRoot)
    expect(text).not.toContain(manifestPath)
  })

  it('names the tool the model has to call for the paths', async () => {
    await registry.activate(SESSION, manifestPath, cwd, hostCaseInsensitive())
    expect(textFor(createSpaceContext(registry), SESSION)).toContain(`\`${WORKSPACE_TOOL_NAME}\``)
  })

  it('contributes nothing for a session with no active space', () => {
    expect(textFor(createSpaceContext(registry), SESSION)).toBe('')
    expect(textFor(createSpaceContext(registry), OTHER)).toBe('')
  })

  it('contributes nothing when the assembly carries no agent (diagnostics)', () => {
    expect(textFor(createSpaceContext(registry), undefined)).toBe('')
  })

  it('reads the LIVE registry, so a space applied later shows up without a remount', async () => {
    const contribution = createSpaceContext(registry)
    expect(textFor(contribution, SESSION)).toBe('')
    await registry.activate(SESSION, manifestPath, cwd, hostCaseInsensitive())
    expect(textFor(contribution, SESSION)).toContain('Operation space "ctx" is active in this session.')
  })

  it('keeps the sessions separate', async () => {
    await registry.activate(SESSION, manifestPath, cwd, hostCaseInsensitive())
    expect(textFor(createSpaceContext(registry), SESSION)).not.toBe('')
    expect(textFor(createSpaceContext(registry), OTHER)).toBe('')
  })
})
