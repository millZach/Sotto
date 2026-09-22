// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assertDevinNoIntegrations, assertDevinWorkingDirectory, devinPolicyPath, prepareDevinPolicy, verifyDevinMcpList, verifyDevinPluginList, verifyDevinPolicy } from '../../../src/main/agents/devinPolicy'

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
  const profiles = await Promise.all([prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig), prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig)])
  expect(profiles[0]).toEqual(profiles[1])
  const profile = profiles[0]!
  const config = JSON.parse(await readFile(profile.path, 'utf8'))
  expect(() => verifyDevinPolicy({ config: { ...config, version: 1, proxy: { mode: 'system', url: null, no_proxy: null } }, configPath: profile.path }, profile)).not.toThrow()
  expect(config.permissions.allow).toEqual([])
  expect(config.permissions.ask).toContain('exec')
  expect(Object.values(config.read_config_from).every(value => value === false)).toBe(true)
})

it('writes one profile per allowance and asks about everything the allowance does not cover', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  const read = async (allows: 'nothing' | 'edits' | 'everything') =>
    JSON.parse(await readFile((await prepareDevinPolicy(userData, allows, cwd, nativeConfig)).path, 'utf8'))
  const nothing = await read('nothing')
  const edits = await read('edits')
  const everything = await read('everything')
  expect(nothing.permissions.allow).toEqual([])
  expect(nothing.permissions.ask).toEqual(expect.arrayContaining(['edit', 'write', 'exec', 'Fetch(*)']))
  expect(edits.permissions.allow).toEqual(expect.arrayContaining(['edit', 'write']))
  expect(edits.permissions.ask).toEqual(['exec', 'Fetch(*)', 'mcp__*'])
  expect(everything.permissions.ask).toEqual([])
  expect(everything.permissions.allow).toEqual(expect.arrayContaining(['edit', 'exec', 'Fetch(*)']))
  // Each allowance gets a file of its own, and the asking one keeps the name a profile had before allowances.
  expect((await prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig)).path).toBe(devinPolicyPath(userData, 'nothing'))
  expect(devinPolicyPath(userData, 'nothing')).toMatch(/approval-policy-v1\.json$/u)
  expect(new Set([devinPolicyPath(userData, 'nothing'), devinPolicyPath(userData, 'edits'), devinPolicyPath(userData, 'everything')]).size).toBe(3)
})

it('confirms a readback only against the allowance its own profile was written for', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  const profile = await prepareDevinPolicy(userData, 'edits', cwd, nativeConfig)
  const config = JSON.parse(await readFile(profile.path, 'utf8'))
  expect(() => verifyDevinPolicy({ config, configPath: profile.path }, profile)).not.toThrow()
  // The same file read back as any other allowance is a profile that does not say what the thread was told.
  expect(() => verifyDevinPolicy({ config, configPath: profile.path }, { ...profile, allows: 'nothing' })).toThrow(/approval profile/iu)
  expect(() => verifyDevinPolicy({ config, configPath: profile.path }, { ...profile, allows: 'everything' })).toThrow(/approval profile/iu)
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
  const { path } = await prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig)
  await writeFile(path, '{}')
  await expect(prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig)).rejects.toThrow(/profile.*changed/u)
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
  const profile = await prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig)
  const { path } = profile
  const config = JSON.parse(await readFile(path, 'utf8'))
  for (const result of [null, {}, { config, configPath: 'relative.json' }, { config, configPath: join(cwd, 'other.json') },
    { config: { ...config, permissions: { ...config.permissions, allow: ['private-value'] } }, configPath: path },
    { config: { ...config, read_config_from: { ...config.read_config_from, claude: true } }, configPath: path },
    { config: { ...config, hooks: { SessionStart: ['private-value'] } }, configPath: path }]) {
    expect(() => verifyDevinPolicy(result, profile)).toThrow(/did not confirm/u)
  }
})

it('accepts only the pinned empty plugin-list response', () => {
  expect(() => verifyDevinPluginList('No plugins installed.\r\n')).not.toThrow()
  for (const output of ['', 'Installed plugins\nexample', 'warning\nNo plugins installed.']) expect(() => verifyDevinPluginList(output)).toThrow()
})


// Devin resolves `.devin` from the working folder upwards only; the pinned CLI
// ignores the same file one level below it. `mcp_config.json` is the file the
// descendant experiment measured, so it is the one asserted here. See
// docs/verification/2026-09-21-devin-config-discovery.md.
it('allows native configuration below the working directory, which the session never reads', async () => {
  const { cwd, nativeConfig } = await setup()
  const directory = join(cwd, 'package', '.devin')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'mcp_config.json'), '{}')
  await expect(assertDevinWorkingDirectory(cwd, nativeConfig)).resolves.toBeUndefined()
})

it('admits a working folder whose size and linked directories no longer decide the check', async () => {
  const { root, cwd, nativeConfig } = await setup()
  const other = join(root, 'outside')
  await mkdir(join(other, '.devin'), { recursive: true })
  await writeFile(join(other, '.devin', 'config.json'), '{}')
  await symlink(other, join(cwd, 'linked'), 'junction')
  await expect(assertDevinWorkingDirectory(cwd, nativeConfig)).resolves.toBeUndefined()
  await rm(join(cwd, 'linked'))
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
  await expect(assertDevinNoIntegrations(process.execPath, [script, '--config', profile], {}, root)).rejects.toThrow('Sotto could not check Devin integrations. Your thread is kept. Check the supported Devin installation and reconnect.')
})


it('accepts native version-one normalization and formatting without accepting new policy fields', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  const profile = await prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig)
  const { path } = profile
  const config = JSON.parse(await readFile(path, 'utf8'))
  expect(config.version).toBe(1)
  await writeFile(path, JSON.stringify(Object.fromEntries(Object.entries(config).reverse())))
  await expect(prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig)).resolves.toEqual(profile)
  for (const change of [{ version: 2 }, { proxy: { mode: 'manual', url: 'https://example.invalid' } }, { api_url: 'https://example.invalid' }]) {
    await writeFile(path, JSON.stringify({ ...config, ...change }))
    await expect(prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig)).rejects.toThrow(/profile.*changed/u)
  }
})

it('refuses unknown normalized fields and native routing or execution overrides', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  const profile = await prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig)
  const { path } = profile
  const config = JSON.parse(await readFile(path, 'utf8'))
  for (const extra of [{ api_url: 'https://example.invalid' }, { proxy: { mode: 'manual', url: 'https://example.invalid', no_proxy: null } },
    { devin: { org_id: 'different-org' } }, { shell: { setup_complete: false, startup_messages_remaining: 10, exec_shell: 'other-shell' } },
    { disabled_tools: ['edit'] }, { agent: { endpoint: 'https://example.invalid' } }]) {
    expect(() => verifyDevinPolicy({ config: { ...config, ...extra }, configPath: path }, profile)).toThrow(/did not confirm/u)
  }
})
