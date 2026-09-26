import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DISCOVERY_LIMIT, discoverManifests } from '../src/workspace-discovery.ts'

let root: string

const VALID = '{ "name": "demo", "folders": [{ "path": "." }] }'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'octopus-discover-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('discoverManifests', () => {
  it('returns nothing for an unreadable directory instead of failing', async () => {
    expect(await discoverManifests(join(root, 'does-not-exist'))).toEqual([])
  })

  it('finds claimed extensions at the top level only', async () => {
    await writeFile(join(root, 'a.dsh-octopus'), VALID, 'utf8')
    await writeFile(join(root, 'b.dsh-workspace'), VALID, 'utf8')
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'deep.dsh-octopus'), VALID, 'utf8')
    expect((await discoverManifests(root)).map(c => c.fileName))
      .toEqual(['a.dsh-octopus', 'b.dsh-workspace'])
  })

  it('ignores unclaimed extensions and directories that look like manifests', async () => {
    await writeFile(join(root, 'a.json'), VALID, 'utf8')
    await writeFile(join(root, 'plain'), VALID, 'utf8')
    await mkdir(join(root, 'dir.dsh-octopus'))
    expect(await discoverManifests(root)).toEqual([])
  })

  it('reports the declared title, the absolute path and the default autoActivate', async () => {
    await writeFile(join(root, 'a.dsh-octopus'), VALID, 'utf8')
    const [candidate] = await discoverManifests(root)
    expect(candidate!.name).toBe('demo')
    expect(candidate!.fileName).toBe('a.dsh-octopus')
    expect(candidate!.path).toBe(join(root, 'a.dsh-octopus'))
    expect(candidate!.autoActivate).toBe(true)
    expect(candidate!.error).toBeUndefined()
  })

  it('honours an explicit autoActivate: false', async () => {
    await writeFile(
      join(root, 'a.dsh-octopus'),
      '{ "folders": ["."], "settings": { "autoActivate": false } }',
      'utf8',
    )
    const [candidate] = await discoverManifests(root)
    expect(candidate!.autoActivate).toBe(false)
  })

  it('lists an unparseable manifest with its error and never auto-applies it', async () => {
    await writeFile(join(root, 'broken.dsh-octopus'), '{ not json', 'utf8')
    const [candidate] = await discoverManifests(root)
    expect(candidate!.fileName).toBe('broken.dsh-octopus')
    expect(candidate!.name).toBe('broken.dsh-octopus')   // falls back to the file name
    expect(candidate!.autoActivate).toBe(false)          // a broken file must not auto-apply
    expect(candidate!.error).toBeTruthy()
  })

  it('sorts by file name so the chooser order is stable', async () => {
    for (const name of ['c.dsh-octopus', 'a.dsh-octopus', 'b.dsh-octopus']) {
      await writeFile(join(root, name), VALID, 'utf8')
    }
    expect((await discoverManifests(root)).map(c => c.fileName))
      .toEqual(['a.dsh-octopus', 'b.dsh-octopus', 'c.dsh-octopus'])
  })

  it('caps one scan at DISCOVERY_LIMIT candidates', async () => {
    for (let i = 0; i < DISCOVERY_LIMIT + 5; i += 1) {
      await writeFile(join(root, `m${String(i).padStart(3, '0')}.dsh-octopus`), VALID, 'utf8')
    }
    expect((await discoverManifests(root)).length).toBe(DISCOVERY_LIMIT)
  })
})
