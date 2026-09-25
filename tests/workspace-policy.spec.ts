import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertWsWriteAllowed, buildWorkspaceFromFile, buildWorkspacePolicy, classifyWsPath,
  WsManifestError, wsWriteAllowed,
  type ActiveWorkspace,
} from '../src/workspace-policy.ts'
import { ensureWsReadTarget, ensureWsWriteTarget } from '../src/workspace-guards.ts'
import { parseWorkspaceManifest } from '../src/workspace-schema.ts'
import {
  rollbackWsViolation, scanWsViolations,
} from '../src/workspace-detector.ts'
import type { SidebarSessionEvent } from '../src/context-types.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dshws-policy-'))
  await mkdir(join(root, 'cwd'))
  await mkdir(join(root, 'docs'))
  await mkdir(join(root, 'cwd', 'nested'))
  await mkdir(join(root, 'other'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Resolve real paths of fixture dirs for assertions (Windows-safe). */
async function real(...parts: string[]): Promise<string> {
  return realpath(join(root, ...parts))
}

const MANIFEST = `{
  "name": "test ws",
  "folders": [
    { "path": "../docs", "access": "readWrite" },
    { "path": "./nested" }                 // unlabeled => readOnly by default
  ]
}`

async function buildFixture(): Promise<ActiveWorkspace> {
  const manifestPath = join(root, 'cwd', 'test.dsh-workspace')
  await writeFile(manifestPath, MANIFEST, 'utf8')
  const cwd = await real('cwd')
  return (await buildWorkspaceFromFile(manifestPath, cwd, false)).workspace
}

describe('workspace policy resolution', () => {
  it('lists manifest folders first, then the implicit cwd readWrite root', async () => {
    const ws = await buildFixture()
    expect(ws.name).toBe('test ws')
    expect(ws.roots.map(r => r.label)).toEqual(['docs', 'nested', 'cwd'])
    expect(ws.roots[0]!.access).toBe('readWrite')
    expect(ws.roots[1]!.access).toBe('readOnly')   // security default
    expect(ws.roots[2]!.access).toBe('readWrite')  // implicit cwd
    expect(ws.roots.every(r => r.exists)).toBe(true)
  })

  it('marks missing listed folders as not existing without dropping others', async () => {
    const manifestPath = join(root, 'cwd', 't.dsh-workspace')
    await writeFile(manifestPath, '{ "folders": [{ "path": "./nope" }, { "path": "../docs" }] }', 'utf8')
    const ws = (await buildWorkspaceFromFile(manifestPath, await real('cwd'), false)).workspace
    expect(ws.roots.find(r => r.label === 'nope')?.exists).toBe(false)
    expect(ws.roots.some(r => r.label === 'docs' && r.exists)).toBe(true)
  })

  it('rejects malformed manifests with a clear error', async () => {
    const manifestPath = join(root, 'cwd', 'bad.dsh-workspace')
    await writeFile(manifestPath, '{ "folders": [] }', 'utf8')
    await expect(buildWorkspaceFromFile(manifestPath, await real('cwd'), false))
      .rejects.toBeInstanceOf(WsManifestError)
  })

  it('longest-prefix wins: a readOnly nested root overrides the implicit rw cwd', async () => {
    const ws = await buildFixture()
    const cwdFile = join(await real('cwd'), 'a.ts')
    const nestedFile = join(await real('cwd', 'nested'), 'b.ts')
    const docsFile = join(await real('docs'), 'c.md')
    const outside = join(await real('other'), 'd.txt')
    for (const f of [cwdFile, nestedFile, docsFile, outside]) await writeFile(f, 'x', 'utf8')
    expect(classifyWsPath(ws, await realpath(cwdFile))?.root.label).toBe('cwd')
    expect(classifyWsPath(ws, await realpath(nestedFile))?.root.label).toBe('nested')
    expect(classifyWsPath(ws, await realpath(docsFile))?.root.label).toBe('docs')
    expect(classifyWsPath(ws, await realpath(outside))).toBeUndefined()
    expect(wsWriteAllowed(ws, await realpath(cwdFile))).toBe(true)
    expect(wsWriteAllowed(ws, await realpath(nestedFile))).toBe(false)
    expect(wsWriteAllowed(ws, await realpath(docsFile))).toBe(true)
  })
})

describe('workspace guards (canonical, multi-base)', () => {
  it('reads inside a base, refuses an existing file outside every base', async () => {
    const ws = await buildFixture()
    const bases = ws.roots.map(r => r.realPath)
    const docsFile = join(await real('docs'), 'c.md')
    await writeFile(docsFile, 'x', 'utf8')
    const target = await ensureWsReadTarget(ws.cwd, docsFile, bases, false)
    expect(target).toBe(await realpath(docsFile))
    const outside = join(await real('other'), 'd.txt')
    await writeFile(outside, 'x', 'utf8')
    await expect(ensureWsReadTarget(ws.cwd, outside, bases, false)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('writes only into the given bases; missing destinations rebuild onto ancestors', async () => {
    const ws = await buildFixture()
    const docsBase = (await real('docs'))
    const newFile = join(docsBase, 'deep', 'n.ts') // deep does not exist yet
    const resolved = await ensureWsWriteTarget(ws.cwd, newFile, [docsBase], false)
    expect(resolved).toBe(join(docsBase, 'deep', 'n.ts'))
    const cwdFile = join(await real('cwd'), 'a.ts')
    await expect(ensureWsWriteTarget(ws.cwd, cwdFile, [docsBase], false)).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('policy-level write gate (longest-prefix overrides)', () => {
  it('assertWsWriteAllowed refuses a readOnly nested root inside the implicit rw cwd', async () => {
    const ws = await buildFixture()
    const nestedFile = join(await real('cwd', 'nested'), 'b.ts')
    const docsFile = join(await real('docs'), 'c.md')
    const cwdFile = join(await real('cwd'), 'a.ts')
    for (const f of [nestedFile, docsFile, cwdFile]) await writeFile(f, 'x', 'utf8')
    const canonicalDocs = await realpath(docsFile)
    const canonicalCwd = await realpath(cwdFile)
    const canonicalNested = await realpath(nestedFile)
    expect(() => assertWsWriteAllowed(ws, canonicalDocs, docsFile)).not.toThrow()
    expect(() => assertWsWriteAllowed(ws, canonicalCwd, cwdFile)).not.toThrow()
    expect(() => assertWsWriteAllowed(ws, canonicalNested, nestedFile))
      .toThrowError(/read-only workspace folder/)
  })
})

describe('read-only write detection + rollback', () => {
  const callEvent = (type: 'tool/call' | 'tool/result', callId: string, name: string, args?: string, time?: number): SidebarSessionEvent => ({
    type,
    seq: 0,
    time: time ?? Date.now(),
    data: type === 'tool/call'
      ? { name, callId, arguments: args ?? '{}' }
      : { message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', content: [{ type: 'text', text: 'ok' }] }] } },
  })

  it('flags settled writes into a readOnly root after activation and restores the prior content', async () => {
    const ws = await buildFixture()
    const cwd = await real('cwd')
    const target = join(cwd, 'nested', 'guarded.txt')
    const beforeAct = ws.activatedAt - 5000
    const afterAct = ws.activatedAt + 1
    // c1 happens BEFORE the workspace was activated: it is the "prior
    // content" source but must not itself be flagged.
    const events: SidebarSessionEvent[] = [
      callEvent('tool/call', 'c1', 'write', JSON.stringify({ file_path: 'nested/guarded.txt', content: 'old' }), beforeAct),
      callEvent('tool/result', 'c1', 'write', undefined, beforeAct),
      callEvent('tool/call', 'c2', 'write', JSON.stringify({ file_path: 'nested/guarded.txt', content: 'intruder' }), afterAct),
      callEvent('tool/result', 'c2', 'write', undefined, afterAct),
    ]
    const violations = await scanWsViolations(ws, cwd, events)
    expect(violations.map(v => v.callId)).toEqual(['c2'])
    expect(violations[0]!.path).toBe(target)
    expect(violations[0]!.rootLabel).toBe('nested')
    expect(violations[0]!.canRestore).toBe(true)
    const result = await rollbackWsViolation(ws, cwd, events, 'c2')
    expect(result.ok).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('old')
  })

  it('ignores writes into readWrite roots', async () => {
    const ws = await buildFixture()
    const cwd = await real('cwd')
    const docsFile = join(await real('docs'), 'ok.txt')
    const events: SidebarSessionEvent[] = [
      callEvent('tool/call', 'c3', 'write', JSON.stringify({ file_path: docsFile, content: 'fine' }), ws.activatedAt + 1),
      callEvent('tool/result', 'c3', 'write', undefined, ws.activatedAt + 1),
    ]
    const violations = await scanWsViolations(ws, cwd, events)
    expect(violations).toEqual([])
  })

  it('flags an edit into a readOnly root and reverse-applies it on rollback', async () => {
    const ws = await buildFixture()
    const cwd = await real('cwd')
    const target = join(cwd, 'nested', 'edited.txt')
    // Simulate the world AFTER the intrusion: the edit really landed on disk.
    await writeFile(target, 'alpha INTRUDER gamma', 'utf8')
    const events: SidebarSessionEvent[] = [
      callEvent('tool/call', 'e1', 'edit', JSON.stringify({
        file_path: 'nested/edited.txt', old_string: 'BETA', new_string: 'INTRUDER',
      }), ws.activatedAt + 1),
      callEvent('tool/result', 'e1', 'edit', undefined, ws.activatedAt + 1),
    ]
    const violations = await scanWsViolations(ws, cwd, events)
    expect(violations.map(v => v.callId)).toEqual(['e1'])
    expect(violations[0]!.kind).toBe('edit')
    // For an edit the flag is optimistic: the payload carries its own inverse,
    // so a strategy exists. Whether it still APPLIES is only knowable at
    // rollback time (the file may have changed since) — see the next test.
    expect(violations[0]!.canRestore).toBe(true)
    const result = await rollbackWsViolation(ws, cwd, events, 'e1')
    expect(result.ok).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('alpha BETA gamma')
  })

  it('refuses an edit rollback when the file no longer contains the edit', async () => {
    const ws = await buildFixture()
    const cwd = await real('cwd')
    const target = join(cwd, 'nested', 'moved-on.txt')
    // The logged edit was later overwritten by something else, so its
    // newString is gone: reverse-applying would corrupt the file.
    await writeFile(target, 'completely different now', 'utf8')
    const events: SidebarSessionEvent[] = [
      callEvent('tool/call', 'e2', 'edit', JSON.stringify({
        file_path: 'nested/moved-on.txt', old_string: 'BETA', new_string: 'INTRUDER',
      }), ws.activatedAt + 1),
      callEvent('tool/result', 'e2', 'edit', undefined, ws.activatedAt + 1),
    ]
    const result = await rollbackWsViolation(ws, cwd, events, 'e2')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/file changed since the edit/)
    expect(await readFile(target, 'utf8')).toBe('completely different now')
  })

  it('marks a write with no prior content in the window as unrestorable', async () => {
    const ws = await buildFixture()
    const cwd = await real('cwd')
    const events: SidebarSessionEvent[] = [
      callEvent('tool/call', 'w1', 'write', JSON.stringify({ file_path: 'nested/fresh.txt', content: 'new' }), ws.activatedAt + 1),
      callEvent('tool/result', 'w1', 'write', undefined, ws.activatedAt + 1),
    ]
    const violations = await scanWsViolations(ws, cwd, events)
    expect(violations.map(v => v.canRestore)).toEqual([false])
    // Reported, but the host has no snapshot layer to restore from: the honest
    // answer is "review it yourself", not a silent no-op success.
    const result = await rollbackWsViolation(ws, cwd, events, 'w1')
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/no earlier content/)
  })

  it('ignores unsettled, errored and non-write calls', async () => {
    const ws = await buildFixture()
    const cwd = await real('cwd')
    const after = ws.activatedAt + 1
    const events: SidebarSessionEvent[] = [
      // Settled, but the tool reported an error: nothing was written.
      callEvent('tool/call', 'x2', 'write', JSON.stringify({ file_path: 'nested/e.txt', content: 'x' }), after),
      {
        type: 'tool/result',
        seq: 0,
        time: after,
        data: {
          message: {
            source: { kind: 'tool', callId: 'x2' },
            content: [{ type: 'tool-result', isError: true, content: [] }],
          },
        },
      },
      // Never settled: no result event for this call yet.
      callEvent('tool/call', 'x3', 'write', JSON.stringify({ file_path: 'nested/r.txt', content: 'x' }), after),
      // A read is not a write.
      callEvent('tool/call', 'x4', 'read', JSON.stringify({ file_path: 'nested/read.txt' }), after),
      callEvent('tool/result', 'x4', 'read', undefined, after),
    ]
    expect(await scanWsViolations(ws, cwd, events)).toEqual([])
    const missing = await rollbackWsViolation(ws, cwd, events, 'nope')
    expect(missing.ok).toBe(false)
    expect(missing.message).toMatch(/no settled write\/edit/)
  })

  it('buildWorkspacePolicy is testable without fs via an injected canonicalize', async () => {
    const parsed = parseWorkspaceManifest('{ "folders": ["/a", { "path": "/a/ro" }] }')
    expect(parsed.errors).toEqual([])
    const build = await buildWorkspacePolicy(
      parsed.manifest!,
      '/ws/t.dsh-workspace',
      '/ws',
      '/cwd',
      false,
      async (p) => p,
    )
    expect(build.workspace.roots.map(r => r.label)).toEqual(['a', 'ro', 'cwd'])
    expect(build.workspace.roots.map(r => r.access)).toEqual(['readOnly', 'readOnly', 'readWrite'])
    expect(build.workspace.roots[0]!.listed).toBe(true)
    expect(build.workspace.roots[2]!.listed).toBe(false)
  })
})
