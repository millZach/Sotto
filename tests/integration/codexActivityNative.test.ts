// @vitest-environment node
// Opt-in installed-client smoke. No thread/turn creation, account/config changes,
// external inference, user history reads or tool execution.
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { CodexAppServerHost } from '../../src/main/agents/codex'
import { findExecutable } from '../../src/main/agents/subscriptionCodex'

it.runIf(process.env.SOTTO_NATIVE_CODEX_ACTIVITY === '1')('connects and reconnects the installed native client with an isolated empty history without starting work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sotto-codex-activity-native-'))
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.includes('sotto-codex-activity-native-')) throw new Error('Unexpected native test directory')
  const home = join(root, 'native-home'); await mkdir(home)
  const executable = await findExecutable()
  expect(executable).not.toBeNull()
  const host = new CodexAppServerHost({ userDataPath: root, executable: executable!, codexHome: home, requestTimeoutMs: 10_000 })
  try {
    const first = await host.connect()
    expect(first.connected).toBe(true)
    expect(first.version).toMatch(/0\.154\.0/)
    expect(first.threads).toEqual([])
    await host.execute({ type: 'create-project', commandId: 'local-project-only', projectId: 'fixture', title: 'Activity smoke', path: root })
    host.disconnect(); await host.closed()
    const second = await host.connect()
    expect(second.connected).toBe(true)
    expect(second.projects).toEqual([{ id: 'fixture', title: 'Activity smoke', path: root }])
    expect(second.threads).toEqual([])
    expect(await readdir(join(home, 'sessions')).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return [] })).toEqual([])
  } finally {
    host.disconnect(); await host.closed()
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}, 30_000)
