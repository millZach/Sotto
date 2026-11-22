// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { antigravityFolders } from '../../../src/main/agents/antigravityFolders'
import { writeAntigravitySettings } from '../../../src/main/agents/antigravityRpc'

describe('writeAntigravitySettings', () => {
  let root = ''
  const folders = () => antigravityFolders(root)
  const settingsPath = () => join(folders().appData, 'settings.json')

  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'sotto-agy-rpc-')) })
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

  it('preserves unrelated keys, updates auth and gcp cleanly, and leaves no temp files', async () => {
    const target = folders()
    await mkdir(target.appData, { recursive: true })
    await writeFile(settingsPath(), JSON.stringify({ permissions: { allow: ['read'] }, customFlag: true }, null, 2) + '\n', 'utf8')

    await writeAntigravitySettings(target, { method: 'oauth-business', project: 'acme-proj', location: 'us-central1' })
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual({
      permissions: { allow: ['read'] },
      customFlag: true,
      auth: { type: 'oauth-business' },
      gcp: { project: 'acme-proj', location: 'us-central1' },
    })

    await writeAntigravitySettings(target, { method: 'oauth-personal' })
    expect(JSON.parse(await readFile(settingsPath(), 'utf8'))).toEqual({
      permissions: { allow: ['read'] },
      customFlag: true,
      auth: { type: 'oauth-personal' },
    })

    expect(await readdir(target.appData)).toEqual(['settings.json'])
  })

  it('skips rewriting when settings.json already holds the exact target state', async () => {
    const target = folders()
    await writeAntigravitySettings(target, { method: 'oauth-personal' })
    const before = await stat(settingsPath())
    await new Promise(resolve => setTimeout(resolve, 25))
    await writeAntigravitySettings(target, { method: 'oauth-personal' })
    const after = await stat(settingsPath())
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.ino).toBe(before.ino)
  })

  it('serializes overlapping writes on the same profile without collisions or leftover temp files', async () => {
    const target = folders()
    await mkdir(target.appData, { recursive: true })
    await writeFile(settingsPath(), JSON.stringify({ permissions: { allow: ['edit'] } }), 'utf8')

    await Promise.all(Array.from({ length: 10 }, (_, index) => writeAntigravitySettings(target, index % 2 === 0
      ? { method: 'oauth-business', project: `proj-${index}`, location: 'us-central1' }
      : { method: 'oauth-personal' })))

    const saved = JSON.parse(await readFile(settingsPath(), 'utf8'))
    expect(saved.permissions).toEqual({ allow: ['edit'] })
    expect(saved.auth).toEqual({ type: 'oauth-personal' })
    expect(saved.gcp).toBeUndefined()
    expect(await readdir(target.appData)).toEqual(['settings.json'])
  })
})
