// @vitest-environment node
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computerUseHelperConfig as onAnyPlatform } from '../../../src/main/agents/providers/codex/codexComputerUseHelper'

const computerUseHelperConfig = (home: string, value: unknown) => onAnyPlatform(home, value, 'win32')

// The shapes the Codex desktop app 26.1111 wrote on Windows, cut to what the switch depends on
// (docs/verification/2026-11-19-codex-computer-use-without-the-app.md).
let home: string
const command = process.execPath
const piped = (pipe = '1') => ({ command, args: ['cua-repl.mjs'], enabled: true, enabled_tools: ['js', 'js_reset', 'turn_ended'],
  env: { SKY_CUA_NATIVE_PIPE: pipe, SKY_CUA_NATIVE_PIPE_DIRECTORY: '\\\\.\\pipe\\codex-computer-use-test' } })
const read = (config: Record<string, unknown>) => ({ config })
async function plugin(version: string, servers: Record<string, unknown>, changed?: Date, name = 'unified-computer-use'): Promise<void> {
  const folder = join(home, 'plugins', 'cache', 'openai-bundled', name, version)
  await mkdir(folder, { recursive: true })
  const file = join(folder, '.mcp.json')
  await writeFile(file, JSON.stringify({ mcpServers: servers }))
  if (changed) await utimes(file, changed, changed)
}
const enabled = { plugins: { 'unified-computer-use@openai-bundled': { enabled: true } } }

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'sotto-codex-cu-helper-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

describe('Computer Use without the Codex app', () => {
  it('turns the pipe off for a configured server with one key, and leaves others alone', async () => {
    const result = await computerUseHelperConfig(home, read({ mcp_servers: { node_repl: piped(), context7: { command: 'cmd' }, docs: { url: 'https://example.test' }, off: piped('0') } }))
    expect(result).toEqual({ keys: { 'mcp_servers.node_repl.env.SKY_CUA_NATIVE_PIPE': '0' }, servers: {} })
  })

  it('gives an enabled plugin\'s piped server its whole definition with the pipe off', async () => {
    await plugin('26.1111.21308', { cua_repl: piped() })
    const { keys, servers } = await computerUseHelperConfig(home, read(enabled))
    expect(keys).toEqual({})
    expect(servers).toEqual({ cua_repl: { ...piped(), env: { ...piped().env, SKY_CUA_NATIVE_PIPE: '0' } } })
  })

  it('reads only the newest version of a plugin', async () => {
    await plugin('26.1103.60933', { cua_repl: piped() }, new Date('2026-11-03'))
    await plugin('26.1111.21308', { cua_repl: piped('0') }, new Date('2026-11-11'))
    expect((await computerUseHelperConfig(home, read(enabled))).servers).toEqual({})
  })

  it('leaves a plugin alone when it is off, when config defines its server, or when its client is gone', async () => {
    await plugin('1', { cua_repl: piped(), relative: { ...piped(), command: 'node.exe' }, gone: { ...piped(), command: join(home, 'missing.exe') } })
    expect((await computerUseHelperConfig(home, read({ plugins: { 'unified-computer-use@openai-bundled': { enabled: false } } }))).servers).toEqual({})
    const configured = await computerUseHelperConfig(home, read({ ...enabled, mcp_servers: { cua_repl: piped() } }))
    expect(configured).toEqual({ keys: { 'mcp_servers.cua_repl.env.SKY_CUA_NATIVE_PIPE': '0' }, servers: {} })
    expect(Object.keys((await computerUseHelperConfig(home, read(enabled))).servers)).toEqual(['cua_repl'])
  })

  it('changes nothing off Windows', async () => {
    await plugin('1', { cua_repl: piped() })
    expect(await onAnyPlatform(home, read({ ...enabled, mcp_servers: { node_repl: piped() } }), 'darwin')).toEqual({ keys: {}, servers: {} })
  })

  it('changes nothing when the config or a plugin file is not what it expects', async () => {
    await plugin('1', { cua_repl: piped() })
    await writeFile(join(home, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use', '1', '.mcp.json'), '{ not json')
    expect(await computerUseHelperConfig(home, read(enabled))).toEqual({ keys: {}, servers: {} })
    expect(await computerUseHelperConfig(home, undefined)).toEqual({ keys: {}, servers: {} })
    expect(await computerUseHelperConfig(home, read({ plugins: { '../escape@openai-bundled': { enabled: true } }, mcp_servers: { 'a.b': piped() } }))).toEqual({ keys: {}, servers: {} })
  })
})
