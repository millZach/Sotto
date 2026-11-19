// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computerUseHelperServers as onAnyPlatform } from '../../../src/main/agents/providers/codex/codexComputerUseHelper'

const computerUseHelperServers = (home: string, value: unknown) => onAnyPlatform(home, value, 'win32')

// The shapes the Codex desktop app 26.1111 wrote on Windows, cut to what the switch depends on
// (docs/verification/2026-11-19-codex-computer-use-without-the-app.md).
let home: string
const command = process.execPath
const piped = (pipe = '1') => ({ command, args: ['cua-repl.mjs'], enabled: true, enabled_tools: ['js', 'js_reset', 'turn_ended'],
  env: { SKY_CUA_NATIVE_PIPE: pipe, SKY_CUA_NATIVE_PIPE_DIRECTORY: '\\\\.\\pipe\\codex-computer-use-test' } })
const off = (server: ReturnType<typeof piped>) => ({ ...server, env: { ...server.env, SKY_CUA_NATIVE_PIPE: '0' } })
const read = (config: Record<string, unknown>) => ({ config })
async function plugin(version: string, servers: Record<string, unknown>, manifest: unknown = './.mcp.json'): Promise<void> {
  const folder = join(home, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use', version)
  await mkdir(join(folder, '.codex-plugin'), { recursive: true })
  await writeFile(join(folder, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'unified-computer-use', version, mcpServers: manifest }))
  await writeFile(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: servers }))
}
const enabled = (policy?: Record<string, unknown>) => ({ plugins: { 'unified-computer-use@openai-bundled': { enabled: true, ...(policy ? { mcp_servers: policy } : {}) } } })

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'sotto-codex-cu-helper-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

describe('Computer Use without the Codex app', () => {
  it('gives a configured server only the switch, and leaves others alone', async () => {
    expect(await computerUseHelperServers(home, read({ mcp_servers: { node_repl: piped(), context7: { command: 'cmd' }, docs: { url: 'https://example.test' }, off: piped('0') } })))
      .toEqual({ node_repl: { env: { SKY_CUA_NATIVE_PIPE: '0' } } })
  })

  it('gives an enabled plugin\'s piped server its whole definition with the switch off', async () => {
    await plugin('26.1111.21308', { cua_repl: piped() })
    expect(await computerUseHelperServers(home, read(enabled()))).toEqual({ cua_repl: off(piped()) })
  })

  it('reads the version Codex loads: local first, then the highest release', async () => {
    await plugin('26.999.1', { cua_repl: piped('0') })
    await plugin('26.1111.21308', { cua_repl: piped() })
    expect(Object.keys(await computerUseHelperServers(home, read(enabled())))).toEqual(['cua_repl'])
    await plugin('local', { cua_repl: piped('0') })
    expect(await computerUseHelperServers(home, read(enabled()))).toEqual({})
  })

  it('orders a name that is not a release as Codex does, by its bytes', async () => {
    await plugin('26.1111.21308', { cua_repl: piped('0') })
    await plugin('latest', { cua_repl: piped() })
    expect(Object.keys(await computerUseHelperServers(home, read(enabled())))).toEqual(['cua_repl'])
  })

  it('leaves a plugin alone when it is off, has the user\'s own policy for the server, or its server is not as expected', async () => {
    await plugin('1.0.0', { cua_repl: piped(), relative: { ...piped(), command: 'node.exe' }, gone: { ...piped(), command: join(home, 'missing.exe') } })
    expect(await computerUseHelperServers(home, read({ plugins: { 'unified-computer-use@openai-bundled': { enabled: false } } }))).toEqual({})
    expect(await computerUseHelperServers(home, read(enabled({ cua_repl: { enabled: false } })))).toEqual({})
    expect(await computerUseHelperServers(home, read({ ...enabled(), mcp_servers: { cua_repl: piped() } }))).toEqual({ cua_repl: { env: { SKY_CUA_NATIVE_PIPE: '0' } } })
    expect(Object.keys(await computerUseHelperServers(home, read(enabled())))).toEqual(['cua_repl'])
  })

  it('changes nothing off Windows', async () => {
    await plugin('1.0.0', { cua_repl: piped() })
    expect(await onAnyPlatform(home, read({ ...enabled(), mcp_servers: { node_repl: piped() } }), 'darwin')).toEqual({})
  })

  it('changes nothing when the config, a version folder or a plugin file is not what it expects', async () => {
    await plugin('1.0.0', { cua_repl: piped() }, './elsewhere.json')
    expect(await computerUseHelperServers(home, read(enabled()))).toEqual({})
    await plugin('1.0.0', { cua_repl: piped() })
    await writeFile(join(home, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use', '1.0.0', '.mcp.json'), '{ not json')
    expect(await computerUseHelperServers(home, read(enabled()))).toEqual({})
    await rm(join(home, 'plugins'), { recursive: true })
    await plugin('1.0.0', { cua_repl: piped() })
    await plugin('1.1.0-beta.1', { cua_repl: piped() })
    expect(await computerUseHelperServers(home, read(enabled()))).toEqual({})
    expect(await computerUseHelperServers(home, undefined)).toEqual({})
    expect(await computerUseHelperServers(home, read({ plugins: { '../escape@openai-bundled': { enabled: true } }, mcp_servers: { 'a.b': piped() } }))).toEqual({})
  })
})
