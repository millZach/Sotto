// @vitest-environment node
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { CodexAppServerHost } from '../../src/main/agents/codex'

it.skipIf(process.env.SOTTO_CODEX_CONNECTION_LIVE !== '1')('connects and opens saved Codex threads without sending a turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sotto-connection-probe-'))
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('sotto-connection-probe-')) throw new Error('Unexpected probe directory')
  const source = process.env.SOTTO_CODEX_PROBE_DATA
  if (!source) throw new Error('Set SOTTO_CODEX_PROBE_DATA to the Sotto data folder')
  const host = new CodexAppServerHost({ userDataPath: directory })
  try {
    for (const file of ['codex-projects.json', 'codex-threads.json']) await copyFile(join(source, file), join(directory, file))
    const snapshot = await host.connect()
    expect(snapshot.connected).toBe(true)
    expect(snapshot.models.length).toBeGreaterThan(0)
    for (const thread of snapshot.threads) await host.refreshThread(thread.id)
    expect((await host.snapshot()).connected).toBe(true)
  } finally {
    host.disconnect(); await host.closed()
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
