// @vitest-environment node
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hostFolderCrumbs, listHostFolders } from '../../../src/main/agents/hostFolders'
import { HOST_FOLDERS_MAX } from '../../../src/shared/hostFolders'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sotto-host-folders-'))
  roots.push(root)
  return root
}

describe('listHostFolders', () => {
  it('lists the home folder when no path is given', async () => {
    const home = await fixture()
    await mkdir(join(home, 'Projects')); await mkdir(join(home, 'Documents'))
    const result = await listHostFolders({}, { home })
    expect(result).toMatchObject({ status: 'listed', path: home, home,
      folders: [{ name: 'Documents', path: join(home, 'Documents'), git: false }, { name: 'Projects', path: join(home, 'Projects'), git: false }] })
  })

  it('hides dot folders', async () => {
    const root = await fixture()
    await mkdir(join(root, '.hidden')); await mkdir(join(root, 'visible'))
    const result = await listHostFolders({ path: root })
    expect(result.status).toBe('listed')
    if (result.status === 'listed') expect(result.folders.map(folder => folder.name)).toEqual(['visible'])
  })

  it('never lists a file', async () => {
    const root = await fixture()
    await writeFile(join(root, 'notes.txt'), 'hello')
    await mkdir(join(root, 'folder'))
    const result = await listHostFolders({ path: root })
    expect(result.status).toBe('listed')
    if (result.status === 'listed') expect(result.folders.map(folder => folder.name)).toEqual(['folder'])
  })

  it('follows a directory symlink but skips a broken one', async () => {
    const root = await fixture()
    const target = join(root, 'target'); await mkdir(target)
    await symlink(target, join(root, 'link'), 'junction')
    await symlink(join(root, 'missing-target'), join(root, 'broken-link'), 'junction')
    const result = await listHostFolders({ path: root })
    expect(result.status).toBe('listed')
    if (result.status === 'listed') expect(result.folders.map(folder => folder.name)).toEqual(['link', 'target'])
  })

  it('flags a folder that holds a Git repository', async () => {
    const root = await fixture()
    await mkdir(join(root, 'repo')); await mkdir(join(root, 'repo', '.git'))
    await mkdir(join(root, 'plain'))
    const result = await listHostFolders({ path: root })
    expect(result.status).toBe('listed')
    if (result.status === 'listed') expect(result.folders).toEqual([
      { name: 'plain', path: join(root, 'plain'), git: false },
      { name: 'repo', path: join(root, 'repo'), git: true },
    ])
  })

  it('sorts case-insensitively', async () => {
    const root = await fixture()
    for (const name of ['banana', 'Apple', 'cherry', 'apple2']) await mkdir(join(root, name))
    const result = await listHostFolders({ path: root })
    expect(result.status).toBe('listed')
    if (result.status === 'listed') expect(result.folders.map(folder => folder.name)).toEqual(['Apple', 'apple2', 'banana', 'cherry'])
  })

  it('caps a folder with more subfolders than the limit and says it was cut short', async () => {
    const root = await fixture()
    const count = HOST_FOLDERS_MAX + 5
    await Promise.all(Array.from({ length: count }, (_, index) => mkdir(join(root, `folder-${String(index).padStart(5, '0')}`))))
    const result = await listHostFolders({ path: root })
    expect(result.status).toBe('listed')
    if (result.status === 'listed') { expect(result.folders).toHaveLength(HOST_FOLDERS_MAX); expect(result.truncated).toBe(true) }
  }, 30_000)

  it('says a folder is missing when it does not exist', async () => {
    const root = await fixture()
    const target = join(root, 'nope')
    await expect(listHostFolders({ path: target })).resolves.toEqual({ status: 'missing', path: target })
  })

  it('refuses a path that is not absolute', async () => {
    await expect(listHostFolders({ path: 'relative/path' })).resolves.toEqual({ status: 'unreadable', path: 'relative/path' })
    await expect(listHostFolders({ path: 'relative/path' }, { platform: 'linux' })).resolves.toEqual({ status: 'unreadable', path: 'relative/path' })
  })

  it.each(['\\\\server\\share', '\\\\?\\C:\\Users', '\\\\.\\PhysicalDrive0', '//server/share', '////server/share'])(
    'refuses the Windows UNC or device path %s',
    async path => { await expect(listHostFolders({ path }, { platform: 'win32' })).resolves.toEqual({ status: 'unreadable', path }) },
  )

  // The drives view probes real drive roots, which only a Windows machine has.
  it.runIf(process.platform === 'win32')('includes the real system drive in the drives view on win32', async () => {
    const result = await listHostFolders({ path: null }, { platform: 'win32' })
    expect(result.status).toBe('listed')
    if (result.status !== 'listed') return
    expect(result.path).toBeNull()
    expect(result.crumbs).toEqual([{ name: 'Drives', path: null }])
    const systemDrive = (process.env.SystemDrive ?? 'C:').toUpperCase()
    expect(result.folders.map(folder => folder.name)).toContain(systemDrive)
    expect(result.folders.every(folder => folder.git === false)).toBe(true)
  })
})

describe('hostFolderCrumbs', () => {
  it('builds the trail down to a Windows folder', () => {
    expect(hostFolderCrumbs(null, 'win32')).toEqual([{ name: 'Drives', path: null }])
    expect(hostFolderCrumbs('C:\\Users\\zach\\Projects', 'win32')).toEqual([
      { name: 'Drives', path: null },
      { name: 'C:', path: 'C:\\' },
      { name: 'Users', path: 'C:\\Users' },
      { name: 'zach', path: 'C:\\Users\\zach' },
      { name: 'Projects', path: 'C:\\Users\\zach\\Projects' },
    ])
  })

  it('builds the trail down to a POSIX folder', () => {
    expect(hostFolderCrumbs('/', 'linux')).toEqual([{ name: '/', path: '/' }])
    expect(hostFolderCrumbs('/home/zach/projects', 'linux')).toEqual([
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'zach', path: '/home/zach' },
      { name: 'projects', path: '/home/zach/projects' },
    ])
  })
})
