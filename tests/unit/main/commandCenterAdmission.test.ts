// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { COMMAND_CENTER_ADMISSIONS, assertCommandCenterAdmission, type CommandCenterAdmission } from '../../../src/main/agents/commandCenterAdmission'
import { readFile } from 'node:fs/promises'

afterEach(() => vi.unstubAllEnvs())
const evidence = (provider: CommandCenterAdmission['provider'], platform: 'win32' | 'darwin' = 'win32'): CommandCenterAdmission => ({ provider, platform,
  version: provider === 'codex' ? '0.162.0' : provider === 'claude' ? '2.1.296' : '1.0.50',
  ...(provider === 'grok' ? { build: 'c58f321264ba' } : {}), verificationNote: 'fixture-only evidence' })

it.each(['codex', 'claude', 'grok'] as const)('keeps %s production admission empty and immune to environment opt-ins', provider => {
  vi.stubEnv('SOTTO_COMMAND_CENTER_LIVE', '1')
  vi.stubEnv('SOTTO_COMMAND_CENTER_ADMISSIONS', JSON.stringify([evidence(provider)]))
  expect(COMMAND_CENTER_ADMISSIONS).toEqual([])
  expect(Object.isFrozen(COMMAND_CENTER_ADMISSIONS)).toBe(true)
  expect(() => assertCommandCenterAdmission(provider, evidence(provider).version, 'win32', undefined, evidence(provider).build))
    .toThrow(expect.objectContaining({ code: 'READ_ONLY_PROFILE_UNAVAILABLE', message: expect.stringContaining('Nothing was sent') }))
})

it.each(['codex', 'claude'] as const)('admits %s at its floor and above only on the checked platform', provider => {
  const entry = evidence(provider)
  expect(() => assertCommandCenterAdmission(provider, entry.version, 'win32', [entry])).not.toThrow()
  expect(() => assertCommandCenterAdmission(provider, provider === 'codex' ? '0.163.0' : '2.1.297', 'win32', [entry])).not.toThrow()
  for (const version of [provider === 'codex' ? '0.161.9' : '2.1.295', 'unreadable', `${entry.version}-preview`]) {
    expect(() => assertCommandCenterAdmission(provider, version, 'win32', [entry])).toThrow('Nothing was sent')
  }
  expect(() => assertCommandCenterAdmission(provider, entry.version, 'darwin', [entry])).toThrow('macOS')
  expect(() => assertCommandCenterAdmission(provider, entry.version, 'linux', [entry])).toThrow('Nothing was sent')
  expect(() => assertCommandCenterAdmission(provider, entry.version, 'win32', [{ ...entry, verificationNote: '' }])).toThrow()
})

it('admits only Grok’s exact version and build', () => {
  const entry = evidence('grok')
  expect(() => assertCommandCenterAdmission('grok', entry.version, 'win32', [entry], entry.build)).not.toThrow()
  for (const [version, build] of [['1.0.51', entry.build], ['1.0.49', entry.build], ['1.0.50', undefined], ['1.0.50', 'other']]) {
    expect(() => assertCommandCenterAdmission('grok', version!, 'win32', [entry], build)).toThrow('Nothing was sent')
  }
})

it('has no production setting, IPC, phone, host or command wiring for admission overrides', async () => {
  for (const file of ['src/shared/settings.ts', 'src/shared/agents.ts', 'src/shared/hostProtocol.ts', 'src/main/ipc/registerIpc.ts', 'src/main/index.ts', 'src/host/index.ts']) {
    expect(await readFile(file, 'utf8')).not.toContain('commandCenterAdmissions')
  }
})
