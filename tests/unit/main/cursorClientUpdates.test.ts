// @vitest-environment node
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProviderClients, type RunLike } from '../../../src/main/agents/providerClients'
import { root } from '../../fixtures/providerClientInstallFixture'

const script = (version: string): Response => new Response(`#!/usr/bin/env bash\nDOWNLOAD_URL="https://downloads.cursor.com/lab/${version}/\${OS}/\${ARCH}/agent-cli-package.tar.gz"\n`, { status: 200 })

describe('Cursor’s client updates (ADR-0042, ADR-0128)', () => {
  it('reads the newest version from Cursor’s install script, and updates its own copy with agent update in Sotto’s Cursor folder', async () => {
    const local = await root('sotto-cursor-local-')
    const folder = join(local, 'cursor-agent', 'versions', '2026.10.22-27dcf5f')
    await mkdir(folder, { recursive: true }); await writeFile(join(folder, 'node.exe'), ''); await writeFile(join(folder, 'index.js'), '')
    const executable = join(folder, 'node.exe')
    const asked: string[] = []
    const runs: { executable: string; args: readonly string[]; env?: NodeJS.ProcessEnv }[] = []
    const run: RunLike = async (program, args, _asNode, options) => { runs.push({ executable: program, args, ...(options?.environment ? { env: options.environment } : {}) }); return { ok: true } }
    const clients = new ProviderClients({ fetchImpl: async url => { asked.push(url); return script('2026.10.24-01-02-03-abcdef1') }, run, cursorConfigDirectory: join(local, 'sotto', 'cursor', 'config') })
    const environment = { LOCALAPPDATA: local, HOME: local, PATH: '', CURSOR_API_KEY: 'never' }
    const reading = await clients.check('cursor', '2026.10.22-27dcf5f', executable, environment)
    expect(asked).toEqual(['https://cursor.com/install'])
    if (process.platform !== 'win32') return
    expect(reading).toMatchObject({ installed: '2026.10.22-27dcf5f', published: '2026.10.24-01-02-03-abcdef1', behind: true, channel: 'self-update', command: 'agent update', canInstall: true })
    expect((await clients.install('cursor', executable, environment)).ok).toBe(true)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ executable, args: [join(folder, 'index.js'), 'update'] })
    expect(runs[0]!.env).toMatchObject({ CURSOR_CONFIG_DIR: join(local, 'sotto', 'cursor', 'config'), NO_OPEN_BROWSER: '1' })
    expect(runs[0]!.env?.CURSOR_API_KEY).toBeUndefined()
  })
  it('is not behind when the install script names the same build, and claims nothing it cannot read', async () => {
    const clients = new ProviderClients({ fetchImpl: async () => script('2026.10.22-27dcf5f') })
    expect((await clients.check('cursor', '2026.10.22-27dcf5f', undefined, {})).behind).toBe(false)
    const unreadable = new ProviderClients({ fetchImpl: async () => new Response('echo hello', { status: 200 }) })
    expect(await unreadable.check('cursor', '2026.10.22-27dcf5f', undefined, {})).toMatchObject({ behind: false, channel: 'unknown' })
  })
  it('leaves a copy another installer put elsewhere to that installer', async () => {
    const elsewhere = join(await root('sotto-cursor-elsewhere-'), 'tools', 'agent.exe')
    const clients = new ProviderClients({ fetchImpl: async () => script('2026.10.24-01-02-03-abcdef1') })
    expect(await clients.check('cursor', '2026.10.22-27dcf5f', elsewhere, { LOCALAPPDATA: join(elsewhere, '..', 'nowhere') })).toMatchObject({ channel: 'unknown', canInstall: false })
  })
})
