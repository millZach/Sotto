// @vitest-environment node
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'

import { join } from 'node:path'
import { expect, it } from 'vitest'
import { assertDevinWorkingDirectory, DEVIN_SOTTO_SERVERS, devinPolicyPath, prepareDevinPolicy, verifyDevinMcpList, verifyDevinPluginList, verifyDevinPolicy } from '../../../src/main/agents/devinPolicy'
import { DEVIN_CLI_VERSION, DevinRefusal } from '../../../src/main/agents/devinRpc'
import { devinOtelDefaults as otelDefaults } from '../../fixtures/devinOtel.mjs'
import { setup } from '../../fixtures/devinPolicyFixture'

it('writes only its owned profile and confirms the native normalized readback', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  const profiles = await Promise.all([prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig), prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig)])
  expect(profiles[0]).toEqual(profiles[1])
  const profile = profiles[0]!
  const config = JSON.parse(await readFile(profile.path, 'utf8'))
  expect(() => verifyDevinPolicy({ config: { ...config, version: 1, proxy: { mode: 'system', url: null, no_proxy: null, gzip: true } }, configPath: profile.path }, profile)).not.toThrow()
  expect(config.permissions.allow).toEqual(DEVIN_SOTTO_SERVERS.map(server => `mcp__${server}__*`))
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
  // Sotto's own tools run without Devin's question on every profile (version 3); every other MCP tool still asks.
  const sotto = ['mcp__sotto_browser__*', 'mcp__sotto_visual__*', 'mcp__sotto_pull_requests__*', 'mcp__sotto_delegate__*']
  expect(nothing.permissions.allow).toEqual(sotto)
  expect(nothing.permissions.ask).toEqual(['edit', 'write', 'Write(**)', 'Write(/**)', 'exec', 'Fetch(*)', 'mcp__*'])
  expect(edits.permissions.allow).toEqual(['edit', 'write', 'Write(**)', 'Write(/**)', ...sotto])
  expect(edits.permissions.ask).toEqual(['exec', 'Fetch(*)', 'mcp__*'])
  expect(everything.permissions.ask).toEqual([])
  expect(everything.permissions.allow).toEqual(expect.arrayContaining(['edit', 'exec', 'Fetch(*)']))
  // Each allowance gets a file of its own, and the asking one keeps the name a profile had before allowances.
  expect((await prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig)).path).toBe(devinPolicyPath(userData, 'nothing'))
  expect(devinPolicyPath(userData, 'nothing')).toMatch(/approval-policy-v3\.json$/u)
  expect(new Set([devinPolicyPath(userData, 'nothing'), devinPolicyPath(userData, 'edits'), devinPolicyPath(userData, 'everything')]).size).toBe(3)
})

it('lets through only Sotto’s own servers by their exact names, and nothing a user server with a similar or folded name could match', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  for (const allows of ['nothing', 'edits'] as const) {
    const { permissions } = JSON.parse(await readFile((await prepareDevinPolicy(userData, allows, cwd, nativeConfig)).path, 'utf8'))
    const mcp = (permissions.allow as string[]).filter(rule => rule.startsWith('mcp__'))
    expect(mcp).toEqual(DEVIN_SOTTO_SERVERS.map(server => `mcp__${server}__*`))
    // Each rule names one whole server: no wildcard in the server name, nothing broader than one server's tools.
    for (const rule of mcp) expect(rule).toMatch(/^mcp__sotto_[a-z_]+__\*$/u)
    expect(permissions.allow).not.toContain('mcp__*')
    const allowed = (name: string) => mcp.some(rule => rule === `mcp__${name}__*`)
    for (const name of ['Sotto_Browser', 'SOTTO_BROWSER', 'sotto-browser', 'sottobrowser', 'sotto_browser_', 'sotto_browser2', 'my_sotto_browser', 'sotto_brows', 'sotto_visual__x', 'ѕotto_browser']) {
      expect(allowed(name), name).toBe(false)
    }
    expect(permissions.ask).toContain('mcp__*')
  }
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

it('reads the Source line 3000.11.92 adds to each server, and still refuses an enabled one', () => {
  const disabled = 'Configured MCP servers:\n\n  ✗ private-name  (disabled)\n    Command: private-value\n    Source: private-file\n\n'
  expect(() => verifyDevinMcpList(disabled)).not.toThrow()
  expect(() => verifyDevinMcpList(disabled + '  ✗ second (disabled)\n    URL: private-value\n    Source: private-file\n')).not.toThrow()
  for (const output of [disabled.replace('✗', '•'), disabled.replace(' (disabled)', ''),
    disabled.replace('    Source: private-file\n', '    Source: private-file\n    Source: other-file\n'), disabled.replace('    Command: private-value\n', '')]) {
    expect(() => verifyDevinMcpList(output)).toThrow(/enabled MCP servers/u)
  }
})

it('says a Devin that reads back an older CLI’s defaults is older than the one Sotto checked', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  const profile = await prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig)
  const config = JSON.parse(await readFile(profile.path, 'utf8'))
  const agent = { model: null, preferred_family_models: {}, show_history_on_continue: true, thinking: { mode: 'auto' }, model_mixture: null, compaction_threshold_tokens: null, codex_tools: false }
  const older = `This Devin version is older than the one Sotto checked. Nothing was sent, and your threads are kept. Use Devin CLI ${DEVIN_CLI_VERSION} or newer, then reconnect Devin.`
  for (const read of [{ ...config, proxy: { mode: 'system', url: null, no_proxy: null } }, { ...config, agent }]) {
    expect(() => verifyDevinPolicy({ config: read, configPath: profile.path }, profile)).toThrow(older)
  }
  // A known block read back wrong still says so, rather than naming a version.
  expect(() => verifyDevinPolicy({ config: { ...config, agent, shell: { setup_complete: true } }, configPath: profile.path }, profile)).toThrow(/did not confirm/u)
})

it('confirms the defaults 3000.11.92 reads back, and refuses any of them changed', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  const profile = await prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig)
  const config = JSON.parse(await readFile(profile.path, 'utf8'))
  const agent = { model: null, subagent_model: null, preferred_family_models: {}, show_history_on_continue: true, thinking: { mode: 'auto' }, model_mixture: null, compaction_threshold_tokens: null, codex_tools: false }
  const read = { ...config, proxy: { mode: 'system', url: null, no_proxy: null, gzip: true }, agent, typewriter: true, local_tools_bypass_permissions: false }
  expect(() => verifyDevinPolicy({ config: read, configPath: profile.path }, profile)).not.toThrow()
  // `devin connect` sessions started in Bypass Permissions, a subagent model of its own, or a proxy setting changed.
  for (const change of [{ local_tools_bypass_permissions: true }, { agent: { ...agent, subagent_model: 'other-model' } }, { proxy: { ...read.proxy, url: 'https://example.invalid' } }]) {
    expect(() => verifyDevinPolicy({ config: { ...read, ...change }, configPath: profile.path }, profile)).toThrow(/did not confirm/u)
  }
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
  for (const extra of [{ proxy: { mode: 'manual', url: 'https://example.invalid', no_proxy: null } },
    { devin: { org_id: 'different-org' } }, { shell: { setup_complete: false, startup_messages_remaining: 10, exec_shell: 'other-shell' } },
    { disabled_tools: ['edit'] }, { agent: { endpoint: 'https://example.invalid' } }]) {
    expect(() => verifyDevinPolicy({ config: { ...config, ...extra }, configPath: path }, profile)).toThrow(/did not confirm/u)
  }
  // A field Sotto has never seen is refused too, and says why.
  expect(() => verifyDevinPolicy({ config: { ...config, api_url: 'https://example.invalid' }, configPath: path }, profile)).toThrow(/newer than the one Sotto checked/u)
})

it('pins telemetry export off in every owned profile', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  for (const allows of ['nothing', 'edits', 'everything'] as const) {
    const config = JSON.parse(await readFile((await prepareDevinPolicy(userData, allows, cwd, nativeConfig)).path, 'utf8'))
    expect(config.otel).toEqual({ enabled: false })
  }
})

it('confirms a readback without otel, with it pinned off, or with the default block that has nowhere to send', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  const profile = await prepareDevinPolicy(userData, 'edits', cwd, nativeConfig)
  const { otel: pinned, ...older } = JSON.parse(await readFile(profile.path, 'utf8'))
  expect(pinned).toEqual({ enabled: false })
  // 3000.10.31 drops the block it does not know; 3000.11.3 reads back the pinned value, or its own default.
  for (const otel of [undefined, { enabled: false }, { enabled: false, ...otelDefaults }, { enabled: true, ...otelDefaults }]) {
    expect(() => verifyDevinPolicy({ config: otel ? { ...older, otel } : older, configPath: profile.path }, profile)).not.toThrow()
  }
})

it('refuses telemetry export that has a destination or settings of its own, in plain words and without its values', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  const profile = await prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig)
  const config = JSON.parse(await readFile(profile.path, 'utf8'))
  for (const otel of [{ enabled: true, ...otelDefaults, endpoint: 'https://private-value.invalid' },
    { enabled: false, ...otelDefaults, endpoint: 'https://private-value.invalid' },
    { enabled: true, ...otelDefaults, logs_endpoint: 'https://private-value.invalid/v1/logs' },
    { enabled: true, ...otelDefaults, metrics_endpoint: 'https://private-value.invalid/v1/metrics' },
    { enabled: true, ...otelDefaults, headers: { Authorization: 'private-value' } },
    { enabled: true, ...otelDefaults, resource_attributes: { 'team.id': 'private-value' } },
    { enabled: true, ...otelDefaults, disable_user_prompt_logging: true },
    // A field Sotto has never seen does not excuse one it knows that could send.
    { enabled: true, ...otelDefaults, endpoint: 'https://private-value.invalid', future_field: 'private-value' },
    { enabled: false, headers: { Authorization: 'private-value' }, future_field: null },
    { enabled: 'yes', future_field: null },
    { enabled: true }, { endpoint: 'https://private-value.invalid' }, true, null]) {
    let refusal: unknown
    try { verifyDevinPolicy({ config: { ...config, otel }, configPath: profile.path }, profile) } catch (error) { refusal = error }
    expect(refusal).toBeInstanceOf(DevinRefusal)
    const message = (refusal as Error).message
    expect(message).toMatch(/telemetry settings that Sotto’s profile does not set.*Nothing was sent, and your threads are kept\. Remove the otel settings/u)
    expect(message).not.toContain('private-value')
  }
})

it('says plainly that a Devin reporting a block Sotto has not checked is newer than the one it checked', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  const profile = await prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig)
  const config = JSON.parse(await readFile(profile.path, 'utf8'))
  const read = (): void => verifyDevinPolicy({ config: { ...config, future_block: { enabled: true, private: 'private-value' } }, configPath: profile.path }, profile)
  expect(read).toThrow(DevinRefusal)
  expect(read).toThrow(`This Devin version is newer than the one Sotto checked, and it has settings Sotto has not checked. Nothing was sent, and your threads are kept. Use Devin CLI ${DEVIN_CLI_VERSION} until Sotto checks this version.`)
  // A block Sotto knows that reads back wrong is still reported as that, not as a newer version.
  expect(() => verifyDevinPolicy({ config: { ...config, future_block: {}, hooks: { SessionStart: ['private-value'] } }, configPath: profile.path }, profile)).toThrow(/did not confirm/u)
})

it('says a Devin is newer, not that it sends telemetry, when otel differs only by a field Sotto has never seen', async () => {
  const { userData, cwd, nativeConfig } = await setup()
  const profile = await prepareDevinPolicy(userData, 'nothing', cwd, nativeConfig)
  const config = JSON.parse(await readFile(profile.path, 'utf8'))
  for (const otel of [{ enabled: false, ...otelDefaults, future_field: 'private-value' },
    { enabled: true, ...otelDefaults, future_field: { private: 'private-value' } },
    { enabled: false, future_field: 'private-value' }]) {
    let refusal: unknown
    try { verifyDevinPolicy({ config: { ...config, otel }, configPath: profile.path }, profile) } catch (error) { refusal = error }
    expect(refusal).toBeInstanceOf(DevinRefusal)
    const message = (refusal as Error).message
    expect(message).toMatch(/^This Devin version is newer than the one Sotto checked/u)
    expect(message).not.toContain('private-value')
  }
  // Still judged after the blocks Sotto knows, so one that reads back wrong is reported as that.
  expect(() => verifyDevinPolicy({ config: { ...config, otel: { enabled: false, future_field: null }, hooks: { SessionStart: ['private-value'] } }, configPath: profile.path }, profile)).toThrow(/did not confirm/u)
})
