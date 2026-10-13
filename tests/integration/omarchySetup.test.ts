// @vitest-environment node
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OmarchySetup } from '../../src/main/omarchy/setup'
import { DEFAULT_SETTINGS, type SettingsPatch } from '../../src/shared/settings'
import omarchyThemes from '../fixtures/omarchy-themes.json'

/** Default executor, real bash/flock/rename and private files; only desktop commands are replaced. */
describe.runIf(process.platform === 'linux')('Omarchy setup across real child processes', () => {
  let root: string, home: string, stateFile: string, bin: string, data: string
  let settings = structuredClone(DEFAULT_SETTINGS)
  const write = async (path: string, value: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }
  const desktop = async (patch: Record<string, unknown>) => {
    await writeFile(stateFile, JSON.stringify({ ...JSON.parse(await readFile(stateFile, 'utf8')), ...patch }))
  }
  const make = () => new OmarchySetup({ home, data, resources: resolve('apps/omarchy'), version: '9.0.0',
    environment: { PATH: `${bin}:/usr/bin:/bin`, OMARCHY_PATH: join(root, 'omarchy'), XDG_RUNTIME_DIR: join(root, 'runtime'), SOTTO_SETUP_FIXTURE_STATE: stateFile },
    settings: { get: async () => settings, update: async (patch: SettingsPatch) => {
      settings = { ...settings, ...patch, worktreeCleanup: { ...settings.worktreeCleanup, ...patch.worktreeCleanup } }; await write(join(data, 'settings.json'), JSON.stringify(settings)); return settings
    } } })
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sotto-omarchy-child-'))
    home = join(root, 'home'); bin = join(root, 'bin'); stateFile = join(root, 'desktop.json'); data = join(root, 'data')
    settings = structuredClone(DEFAULT_SETTINGS)
    await mkdir(bin); await mkdir(join(root, 'runtime'))
    await write(join(home, '.config/hypr/bindings.lua'), '-- User bindings\n')
    await write(join(home, '.config/omarchy/shell.json'), '{"bar":{"layout":{"center":[{"id":"omarchy.indicators"}]}}}')
    await write(join(home, '.local/state/omarchy/current/theme/colors.toml'), 'background = "#1e1e2e"\n')
    await write(stateFile, JSON.stringify({ calls: [], shell: true, lua: true, oldError: '', newError: '', rendered: JSON.stringify(omarchyThemes.themes.catppuccin.rendered) }))
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
    for (const command of ['hyprctl', 'luac', 'omarchy', 'omarchy-shell', 'omarchy-theme-set-templates']) {
      const path = command === 'omarchy-theme-set-templates' ? join(root, 'omarchy/bin', command) : join(bin, command)
      await write(path, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve('tests/fixtures/fakeOmarchySetupCommand.mjs'))} ${quote(command)} "$@"\n`)
      await chmod(path, 0o755)
    }
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  it('sets up, reopens its ownership record, removes everything and preserves user bindings', async () => {
    const result = await make().command({ type: 'setup', pieces: ['keys', 'owl', 'theme'], keys: 'give' })
    expect(Object.values(result.pieces).map(piece => piece.status)).toEqual(['done', 'done', 'done'])
    const reopened = make()
    expect(Object.values((await reopened.get()).pieces).map(piece => piece.status)).toEqual(['done', 'done', 'done'])
    await reopened.command({ type: 'remove', pieces: ['keys', 'owl', 'theme'] })
    expect(await readFile(join(home, '.config/hypr/bindings.lua'), 'utf8')).toBe('-- User bindings\n')
    expect(await readFile(join(home, '.config/omarchy/plugins/sotto.dictation/manifest.json'), 'utf8').catch(() => null)).toBeNull()
    expect(await readFile(join(home, '.config/omarchy/themed/sotto.json.tpl'), 'utf8').catch(() => null)).toBeNull()
    expect(settings.appearance).toBe(DEFAULT_SETTINGS.appearance)
    expect(JSON.parse(await readFile(join(data, 'omarchy-setup.json'), 'utf8')).pieces).toEqual({})
  })
  it('restores an original file after a new compositor error and works on a later retry', async () => {
    await desktop({ newError: 'line 99: injected bad binding\n' })
    const engine = make()
    const failed = await engine.command({ type: 'setup', pieces: ['keys'], keys: 'give' })
    expect(failed.pieces.keys.message).toContain('line 99: injected bad binding')
    expect(await readFile(join(home, '.config/hypr/bindings.lua'), 'utf8')).toBe('-- User bindings\n')
    await desktop({ newError: '' })
    expect((await engine.command({ type: 'setup', pieces: ['keys'], keys: 'give' })).pieces.keys.status).toBe('done')
  })
  it('rolls the theme script back when rendering leaves unresolved colours', async () => {
    await desktop({ rendered: '{"colors":"{{ unresolved }}"}' })
    const result = await make().command({ type: 'setup', pieces: ['theme'], keys: 'give' })
    expect(result.pieces.theme.status).toBe('failed')
    expect(await readFile(join(home, '.config/omarchy/themed/sotto.json.tpl'), 'utf8').catch(() => null)).toBeNull()
    expect(settings.lightTheme).toBe(DEFAULT_SETTINGS.lightTheme)
  })
})
