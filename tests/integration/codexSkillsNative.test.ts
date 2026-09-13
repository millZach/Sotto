// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { CodexAppServerHost } from '../../src/main/agents/codex'

// Explicit opt-in: reads the installed account's catalog, never creates a thread,
// starts a turn, changes account/configuration, or reads skill instructions.
it.skipIf(process.env.SOTTO_VERIFY_CODEX_SKILLS !== '1')('reads the installed native catalog for the actual workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-skills-probe-'))
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-skills-probe-')) throw new Error('Unexpected probe directory')
  const host = new CodexAppServerHost({ userDataPath: directory })
  try {
    const snapshot = await host.connect()
    const cwd = process.cwd()
    const initial = await host.listThreadSkills('unstarted-read-only-probe', false, { providerId: 'codex', workingDirectory: cwd })
    const refreshed = await host.listThreadSkills('unstarted-read-only-probe', true, { providerId: 'codex', workingDirectory: cwd })
    expect(initial.status).toBe('ready')
    expect(refreshed.status).toBe('ready')
    expect(initial.cwd).toBe(cwd)
    expect((await host.snapshot()).threads).toEqual([])
    const artifact = resolve('artifacts/skills-native/catalog-probe.json')
    await mkdir(dirname(artifact), { recursive: true })
    await writeFile(artifact, JSON.stringify({ checkedAt: new Date().toISOString(), version: snapshot.version, cwd,
      initialCount: initial.skills.length, refreshedCount: refreshed.skills.length,
      scopes: [...new Set(refreshed.skills.map(skill => skill.scope))],
      nativeErrorCount: refreshed.errors.length, nativeTurnsStarted: 0,
      methods: ['initialize', 'model/list', 'skills/list'],
      limitation: 'Catalog only. No paid turn, model behavior, or separate user-invocable flag verified.',
    }, null, 2) + '\n')
  } finally {
    host.disconnect(); await host.closed()
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
