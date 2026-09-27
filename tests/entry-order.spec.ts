/**
 * The row order the two file panes share.
 *
 * The built-in 工作区文件 tab sorts directories first and then uses a NATURAL,
 * case-insensitive collator (`orderEntries` in
 * `@deepseek-ai/dsh-client-ui-sidebar-files/lib/client.js`), so `file2` precedes
 * `file10`. That is not a detail: putting the same folder side by side in the two
 * tabs is the whole point, and a different order reads as a different folder.
 */
import { describe, expect, it } from 'vitest'
import { orderEntries } from '../src/client/entry-order.ts'
import type { FsEntry } from '../src/client/api.ts'

/**
 * One listing row.
 * @param name - entry name.
 * @param isDir - whether it is a directory.
 * @returns the entry.
 */
function entry(name: string, isDir: boolean): FsEntry {
  return { name, path: `D:\\demo\\${name}`, isDir, hidden: false, isSymlink: false, broken: false }
}

describe('operation-space row order', () => {
  it('puts directories first and orders each group naturally, ignoring case', () => {
    const listed = [
      entry('file10.md', false),
      entry('src', true),
      entry('File2.md', false),
      entry('docs', true),
      entry('.hidden', false),
    ]
    expect(orderEntries(listed).map((item) => item.name)).toEqual([
      'docs',
      'src',
      '.hidden',
      'File2.md',
      'file10.md',
    ])
  })

  it('does not mutate the listing it was given', () => {
    const listed = [entry('b', false), entry('a', true)]
    const ordered = orderEntries(listed)
    expect(ordered).not.toBe(listed)
    expect(listed.map((item) => item.name)).toEqual(['b', 'a'])
  })

  it('keeps a single empty level intact', () => {
    expect(orderEntries([])).toEqual([])
  })
})
