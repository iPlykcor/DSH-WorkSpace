/**
 * The model-facing operation-space report: what the model gets for its tokens.
 *
 * Two things are being pinned here, and the second one is why this file exists at
 * all. The obvious one is the format: roots grouped by access level so the level
 * is stated once per heading instead of once per root, one root per line, and
 * exactly two markers (`implicit`, `missing`) because those are the only two
 * conditions that change what the model should do next. The less obvious one is
 * SIZE — the report is the thing a model pays for on every call, so a test
 * asserts it stays far smaller than the wire snapshot it is derived from. Without
 * that guard, "just serialize the snapshot" would look like a reasonable future
 * edit and quietly double the cost.
 *
 * The wire snapshot itself is NOT this module's concern: seven routes and the
 * whole client depend on its shape, so it is pinned where it lives.
 */
import { describe, expect, it } from 'vitest'
import type { WsRootSnapshot, WsSnapshot } from '../src/workspace-state.ts'
import { renderNoSpaceReport, renderSpaceLabels, renderSpaceReport } from '../src/workspace-report.ts'
import { WORKSPACE_TOOL_NAME } from '../src/workspace-tool.ts'

/** One root of a fixture snapshot. */
function root(overrides: Partial<WsRootSnapshot> & { path: string; label: string }): WsRootSnapshot {
  return { access: 'readOnly', exists: true, listed: true, ...overrides }
}

/** A fixture snapshot; the defaults mirror a real one closely enough to measure. */
function snapshot(roots: WsRootSnapshot[]): WsSnapshot {
  return {
    manifestPath: 'D:/DSH_WorkSpace/dsh-workspace_Development/demo.dsh-octopus',
    name: 'demo',
    cwd: 'D:/DSH_WorkSpace/dsh-workspace_Development',
    ci: true,
    roots,
    activatedAt: 1789000000000,
  }
}

describe('operation-space report (the model-facing view)', () => {
  it('names the space and its manifest, then groups roots by access', () => {
    const report = renderSpaceReport(snapshot([
      root({ path: './demo/rw', label: 'rw', access: 'readOnly' }),
      root({ path: 'D:/VS调试', label: 'VS调试', access: 'readWrite' }),
      root({ path: 'D:/现场问题', label: '现场问题', access: 'readWrite' }),
    ]))
    expect(report).toBe([
      'Operation space "demo" is ACTIVE in this session.',
      'Manifest: D:/DSH_WorkSpace/dsh-workspace_Development/demo.dsh-octopus',
      'read-write (2):',
      '  VS调试 = D:/VS调试',
      '  现场问题 = D:/现场问题',
      'read-only (1):',
      '  rw = ./demo/rw',
    ].join('\n'))
  })

  it('states the level once per group, never once per root', () => {
    const report = renderSpaceReport(snapshot([
      root({ path: 'D:/a', label: 'a', access: 'readWrite' }),
      root({ path: 'D:/b', label: 'b', access: 'readWrite' }),
      root({ path: 'D:/c', label: 'c', access: 'readOnly' }),
    ]))
    // The level appears in the headings only: a per-root repeat is the exact
    // waste this rendering exists to remove.
    expect(report.match(/read-write/g)).toHaveLength(1)
    expect(report.match(/read-only/g)).toHaveLength(1)
    expect(report.match(/access/g)).toBeNull()
  })

  it('omits a group that has no roots', () => {
    const writeOnly = renderSpaceReport(snapshot([root({ path: 'D:/a', label: 'a', access: 'readWrite' })]))
    expect(writeOnly).not.toContain('read-only')
    const readOnlyOnly = renderSpaceReport(snapshot([root({ path: 'D:/a', label: 'a' })]))
    expect(readOnlyOnly).not.toContain('read-write')
  })

  it('keeps the manifest order inside a group', () => {
    const report = renderSpaceReport(snapshot([
      root({ path: 'D:/z', label: 'z', access: 'readWrite' }),
      root({ path: 'D:/a', label: 'a', access: 'readWrite' }),
      root({ path: 'D:/m', label: 'm', access: 'readWrite' }),
    ]))
    const order = ['z = D:/z', 'a = D:/a', 'm = D:/m'].map(line => report.indexOf(line))
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(order.every(at => at >= 0)).toBe(true)
  })

  it('marks a root whose folder is gone, and the implicit cwd root, and both together', () => {
    const report = renderSpaceReport(snapshot([
      root({ path: 'D:/gone', label: 'gone', exists: false }),
      root({ path: 'D:/cwd', label: 'cwd', access: 'readWrite', listed: false }),
      root({ path: 'D:/both', label: 'both', access: 'readWrite', listed: false, exists: false }),
      root({ path: 'D:/fine', label: 'fine' }),
    ]))
    expect(report).toContain('gone = D:/gone (missing)')
    expect(report).toContain('cwd = D:/cwd (implicit)')
    // Both markers, implicit first: it explains the manifest's silence, which is
    // the more surprising of the two facts.
    expect(report).toContain('both = D:/both (implicit, missing)')
    expect(report).toContain('fine = D:/fine')
    expect(report).not.toContain('fine = D:/fine (')
  })

  it('carries no wire-format field the model cannot use', () => {
    const report = renderSpaceReport(snapshot([
      root({ path: 'D:/a', label: 'a', access: 'readWrite' }),
      root({ path: 'D:/b', label: 'b' }),
    ]))
    for (const noise of ['sessionId', 'cwd:', 'ci:', 'activatedAt', 'realPath', '"access"', '{']) {
      expect(report, `the report should not carry ${noise}`).not.toContain(noise)
    }
  })

  it('stays far smaller than the wire snapshot it is derived from', () => {
    const roots = [
      root({ path: './demo/rw', label: 'rw' }),
      root({ path: './demo/ro', label: 'ro' }),
      root({ path: 'C:/Users/E-peng.liu/Desktop/新人培养', label: '新人培养', access: 'readWrite' }),
      root({ path: 'C:/Users/E-peng.liu/Desktop/app', label: 'app', access: 'readWrite' }),
      root({ path: 'C:/Users/E-peng.liu/Desktop/简历', label: '简历', access: 'readWrite' }),
      root({ path: 'C:/Users/E-peng.liu/Desktop/dsh-better-sidebar-offline', label: 'dsh-better-sidebar-offline' }),
      root({ path: 'D:/VS调试', label: 'VS调试', access: 'readWrite' }),
      root({ path: 'D:/liupeng', label: 'liupeng', access: 'readWrite' }),
      root({ path: 'D:/现场问题', label: '现场问题', access: 'readWrite' }),
      root({ path: 'D:\\DSH_WorkSpace\\dsh-workspace_Test2', label: 'dsh-workspace_Test2' }),
    ]
    const wire = JSON.stringify(snapshot(roots))
    const report = renderSpaceReport(snapshot(roots))
    expect(report.length * 2).toBeLessThan(wire.length)
    // Every root survives the diet, exactly once.
    for (const entry of roots) expect(report).toContain(`${entry.label} = ${entry.path}`)
    expect(report.match(/D:\/VS调试/g)).toHaveLength(1)
  })

  it('answers "not active" with where a space comes from, not with fields', () => {
    const report = renderNoSpaceReport()
    expect(report).toContain('No operation space is active')
    expect(report).toContain('章鱼作业区')
    expect(report).toContain('.dsh-octopus')
    expect(report).not.toContain('{')
    expect(report.length).toBeGreaterThan(0)
  })
})

describe('operation-space label table (the runtime-context view)', () => {
  /** The same ten-root fixture the report's size guard uses. */
  const tenRoots = [
    root({ path: './demo/rw', label: 'rw' }),
    root({ path: './demo/ro', label: 'ro' }),
    root({ path: 'C:/Users/E-peng.liu/Desktop/新人培养', label: '新人培养', access: 'readWrite' }),
    root({ path: 'C:/Users/E-peng.liu/Desktop/app', label: 'app', access: 'readWrite' }),
    root({ path: 'C:/Users/E-peng.liu/Desktop/简历', label: '简历', access: 'readWrite' }),
    root({ path: 'C:/Users/E-peng.liu/Desktop/dsh-better-sidebar-offline', label: 'dsh-better-sidebar-offline' }),
    root({ path: 'D:/VS调试', label: 'VS调试', access: 'readWrite' }),
    root({ path: 'D:/liupeng', label: 'liupeng', access: 'readWrite' }),
    root({ path: 'D:/现场问题', label: '现场问题', access: 'readWrite' }),
    root({ path: 'D:\\DSH_WorkSpace\\dsh-workspace_Test2', label: 'dsh-workspace_Test2' }),
  ]

  it('lists the labels by access, names the tool, and stays on one line', () => {
    const labels = renderSpaceLabels(snapshot([
      root({ path: './demo/rw', label: 'rw', access: 'readOnly' }),
      root({ path: 'D:/VS调试', label: 'VS调试', access: 'readWrite' }),
      root({ path: 'D:/现场问题', label: '现场问题', access: 'readWrite' }),
    ]), WORKSPACE_TOOL_NAME)
    expect(labels).toBe(
      'Operation space "demo" is active in this session. '
      + 'Roots by label: read-write - VS调试, 现场问题; read-only - rw. '
      + 'Absolute paths: call the `octopus_space` tool.',
    )
  })

  it('omits a group with no roots, and states each level once', () => {
    const writeOnly = renderSpaceLabels(snapshot([root({ path: 'D:/a', label: 'a', access: 'readWrite' })]), WORKSPACE_TOOL_NAME)
    expect(writeOnly).not.toContain('read-only')
    expect(writeOnly.match(/read-write/g)).toHaveLength(1)
    const readOnlyOnly = renderSpaceLabels(snapshot([root({ path: 'D:/a', label: 'a' })]), WORKSPACE_TOOL_NAME)
    expect(readOnlyOnly).not.toContain('read-write')
  })

  it('keeps the manifest order inside a group and carries both markers', () => {
    const labels = renderSpaceLabels(snapshot([
      root({ path: 'D:/z', label: 'z', access: 'readWrite' }),
      root({ path: 'D:/a', label: 'a', access: 'readWrite', exists: false }),
      root({ path: 'D:/m', label: 'm', access: 'readWrite', listed: false, exists: false }),
    ]), WORKSPACE_TOOL_NAME)
    expect(labels).toContain('read-write - z, a (missing), m (implicit, missing)')
  })

  it('carries NO absolute path — that is the whole point of it being separate', () => {
    const labels = renderSpaceLabels(snapshot(tenRoots), WORKSPACE_TOOL_NAME)
    for (const entry of tenRoots) {
      expect(labels, `the label table must not carry ${entry.path}`).not.toContain(entry.path)
    }
    expect(labels).not.toContain('/')
    // Every label survives: the model's job is to recognise the user's words.
    for (const entry of tenRoots) expect(labels).toContain(entry.label)
  })

  it('names the tool from the one place that owns the name', () => {
    const labels = renderSpaceLabels(snapshot(tenRoots), WORKSPACE_TOOL_NAME)
    expect(labels).toContain(`\`${WORKSPACE_TOOL_NAME}\``)
  })

  it('is far smaller than the tool report, because it is paid every turn', () => {
    const labels = renderSpaceLabels(snapshot(tenRoots), WORKSPACE_TOOL_NAME)
    const report = renderSpaceReport(snapshot(tenRoots))
    expect(labels.length * 2).toBeLessThan(report.length)
  })

  it('returns nothing for a space that declares no roots', () => {
    expect(renderSpaceLabels(snapshot([]), WORKSPACE_TOOL_NAME)).toBe('')
  })
})
