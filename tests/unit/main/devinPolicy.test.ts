// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assertDevinNoIntegrations, assertDevinWorkingDirectory, prepareDevinPolicy, verifyDevinMcpList, verifyDevinPluginList, verifyDevinPolicy } from '../../../src/main/agents/devinPolicy'

const roots: string[] = []
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-devin-policy-'))
  roots.push(root)
  const cwd = join(root, 'project', 'nested')
  await mkdir(cwd, { recursive: true })
  return { root, cwd, userData: join(root, 'sotto'), nativeConfig: join(root, 'native') }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('writes only its owned profile and confirms the native normalized readback', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  const paths = await Promise.all([prepareDevinPolicy(userData, cwd, nativeConfig), prepareDevinPolicy(userData, cwd, nativeConfig)])
  expect(paths[0]).toBe(paths[1])
  const config = JSON.parse(await readFile(paths[0]!, 'utf8'))
  expect(() => verifyDevinPolicy({ config: { ...config, version: 1, proxy: { mode: 'system', url: null, no_proxy: null } }, configPath: paths[0] }, paths[0]!)).not.toThrow()
  expect(config.permissions.allow).toEqual([])
  expect(config.permissions.ask).toContain('exec')
  expect(Object.values(config.read_config_from).every(value => value === false)).toBe(true)
})

it.each(['config.json', 'config.local.json', 'hooks.v1.json', 'mcp_config.json', 'mcp_config.local.json'])('refuses inherited native %s without parsing its contents', async name => {
  const { root, cwd, nativeConfig } = await setup()
  await mkdir(join(root, 'project', '.devin'))
  const path = join(root, 'project', '.devin', name)
  await writeFile(path, 'not JSON: private native values must never enter errors')
  await expect(assertDevinWorkingDirectory(cwd, nativeConfig)).rejects.toThrow(/native configuration/u)
  expect(await readFile(path, 'utf8')).toBe('not JSON: private native values must never enter errors')
})

it('leaves native global MCP configuration unread for the native status check', async () => {
  const { nativeConfig } = await setup()
  await mkdir(nativeConfig)
  await writeFile(join(nativeConfig, 'mcp_config.json'), '{}')
  await expect(assertDevinWorkingDirectory(undefined, nativeConfig)).resolves.toBeUndefined()
})

it('keeps a modified profile intact and refuses to use it', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  const path = await prepareDevinPolicy(userData, cwd, nativeConfig)
  await writeFile(path, '{}')
  await expect(prepareDevinPolicy(userData, cwd, nativeConfig)).rejects.toThrow(/profile.*changed/u)
  expect(await readFile(path, 'utf8')).toBe('{}')
})

it('refuses a symlink in place of native configuration', async () => {
  const { root, cwd, nativeConfig } = await setup()
  await mkdir(join(root, 'project', '.devin'))
  // Directory junctions need no symlink privilege on Windows; presence is enough.
  await symlink(root, join(root, 'project', '.devin', 'config.json'), 'junction')
  await expect(assertDevinWorkingDirectory(cwd, nativeConfig)).rejects.toThrow(/native configuration/u)
  await rm(join(root, 'project', '.devin', 'config.json'))
})

it('refuses wrong paths, rules, imports and missing protocol fields without exposing their values', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  const path = await prepareDevinPolicy(userData, cwd, nativeConfig)
  const config = JSON.parse(await readFile(path, 'utf8'))
  for (const result of [null, {}, { config, configPath: 'relative.json' }, { config, configPath: join(cwd, 'other.json') },
    { config: { ...config, permissions: { ...config.permissions, allow: ['private-value'] } }, configPath: path },
    { config: { ...config, read_config_from: { ...config.read_config_from, claude: true } }, configPath: path },
    { config: { ...config, hooks: { SessionStart: ['private-value'] } }, configPath: path }]) {
    expect(() => verifyDevinPolicy(result, path)).toThrow(/did not confirm/u)
  }
})

it('accepts only the pinned empty plugin-list response', () => {
  expect(() => verifyDevinPluginList('No plugins installed.\r\n')).not.toThrow()
  for (const output of ['', 'Installed plugins\nexample', 'warning\nNo plugins installed.']) expect(() => verifyDevinPluginList(output)).toThrow()
})


it('refuses native configuration below the initial working directory before lazy native discovery', async () => {
  const { cwd, nativeConfig } = await setup()
  const directory = join(cwd, 'package', '.devin')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'hooks.v1.json'), '{}')
  await expect(assertDevinWorkingDirectory(cwd, nativeConfig)).rejects.toThrow(/native configuration/u)
})

it('refuses a linked directory whose native settings cannot be bounded to this working tree', async () => {
  const { root, cwd, nativeConfig } = await setup()
  const other = join(root, 'outside')
  await mkdir(other)
  const link = join(cwd, 'linked')
  await symlink(other, link, 'junction')
  await expect(assertDevinWorkingDirectory(cwd, nativeConfig)).rejects.toThrow(/linked directories/u)
  await rm(link)
})


it('accepts empty or entirely disabled native MCP and rejects enabled or ambiguous output', () => {
  expect(() => verifyDevinMcpList("No MCP servers configured. Use 'devin mcp add' to add servers.\r\n")).not.toThrow()
  const disabled = 'Configured MCP servers:\n\n  \u2717 private-name (disabled)\n    Command: private-value\n'
  expect(() => verifyDevinMcpList(disabled)).not.toThrow()
  expect(() => verifyDevinMcpList(disabled + '\n  \u2717 second (disabled)\n    URL: private-value\n')).not.toThrow()
  for (const output of ['', 'Configured MCP servers:', disabled.replace('\u2717', '\u2022'), disabled.replace(' (disabled)', ''),
    disabled.replace('Command:', 'Unknown:'), disabled + 'warning', disabled.replace('    Command: private-value\n', '')]) {
    expect(() => verifyDevinMcpList(output)).toThrow(/enabled MCP servers/u)
  }
})


it('bounds native integration checks and keeps subprocess output out of failures', async () => {
  const { root } = await setup()
  const script = join(root, 'native-list.cjs')
  const profile = join(root, 'profile.json')
  await writeFile(profile, '{}')
  await writeFile(script, "console.log(process.argv.includes('plugins') ? 'No plugins installed.' : \"No MCP servers configured. Use 'devin mcp add' to add servers.\")")
  await expect(assertDevinNoIntegrations(process.execPath, [script, '--config', profile], {}, root)).resolves.toBeUndefined()
  await expect(assertDevinNoIntegrations(process.execPath, [script], {}, root)).rejects.toThrow(/require the Sotto/u)
  await writeFile(script, "console.error('PRIVATE_PROVIDER_OUTPUT'); process.exit(1)")
  await expect(assertDevinNoIntegrations(process.execPath, [script, '--config', profile], {}, root)).rejects.toThrow('Sotto could not check Devin integrations. Nothing was sent. Check the supported Devin installation and reconnect.')
})


it('accepts native version-one normalization and formatting without accepting new policy fields', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  const path = await prepareDevinPolicy(userData, cwd, nativeConfig)
  const config = JSON.parse(await readFile(path, 'utf8'))
  expect(config.version).toBe(1)
  await writeFile(path, JSON.stringify(Object.fromEntries(Object.entries(config).reverse())))
  await expect(prepareDevinPolicy(userData, cwd, nativeConfig)).resolves.toBe(path)
  for (const change of [{ version: 2 }, { proxy: { mode: 'manual', url: 'https://example.invalid' } }, { api_url: 'https://example.invalid' }]) {
    await writeFile(path, JSON.stringify({ ...config, ...change }))
    await expect(prepareDevinPolicy(userData, cwd, nativeConfig)).rejects.toThrow(/profile.*changed/u)
  }
})

it('refuses unknown normalized fields and native routing or execution overrides', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  const path = await prepareDevinPolicy(userData, cwd, nativeConfig)
  const config = JSON.parse(await readFile(path, 'utf8'))
  for (const extra of [{ api_url: 'https://example.invalid' }, { proxy: { mode: 'manual', url: 'https://example.invalid', no_proxy: null } },
    { devin: { org_id: 'different-org' } }, { shell: { setup_complete: false, startup_messages_remaining: 10, exec_shell: 'other-shell' } },
    { disabled_tools: ['edit'] }, { agent: { endpoint: 'https://example.invalid' } }]) {
    expect(() => verifyDevinPolicy({ config: { ...config, ...extra }, configPath: path }, path)).toThrow(/did not confirm/u)
  }
})
