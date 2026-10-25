// @vitest-environment node
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { bundleDesktopMain } from '../fixtures/desktopMainBundle'
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
    for (const command of ['bash', 'hyprctl', 'luac', 'omarchy', 'omarchy-shell', 'omarchy-theme-set-templates']) {
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
  it.each([
    ['keys', 'setup', 'hyprctl reload', '.config/hypr/sotto-bindings.lua'],
    ['owl', 'setup', 'omarchy-shell shell rescanPlugins', '.config/omarchy/plugins/sotto.dictation/manifest.json'],
    ['owl', 'setup', 'after omarchy plugin disable sotto.dictation', '.config/omarchy/plugins/sotto.dictation/manifest.json'],
    ['owl', 'setup', 'after omarchy bar put sotto.dictation --section center --after omarchy.indicators', '.config/omarchy/plugins/sotto.dictation/manifest.json'],
    ['theme', 'setup', 'omarchy-theme-set-templates', '.config/omarchy/themed/sotto.json.tpl'],
    ['keys', 'remove', 'hyprctl reload', '.config/hypr/sotto-bindings.lua'],
    ['owl', 'remove', 'after omarchy plugin disable sotto.dictation', '.config/omarchy/plugins/sotto.dictation/manifest.json'],
    ['theme', 'remove', 'bash after', '.config/omarchy/themed/sotto.json.tpl'],
  ] as const)('keeps %s removable after %s is killed during a slow command', async (piece, operation, blockAt, installed) => {
    if (operation === 'remove') await make().command({ type: 'setup', pieces: [piece], keys: 'give' })
    const serviceRepair = operation === 'setup' && blockAt.startsWith('after omarchy ')
    if (serviceRepair) {
      await make().command({ type: 'setup', pieces: ['owl'], keys: 'give' })
      await write(join(home, '.config/omarchy/shell.json'), JSON.stringify({ plugins: [{ id: 'sotto.dictation', command: '/my/sotto', pillEdge: 'bottom' }],
        bar: { layout: { center: [{ id: 'omarchy.indicators' }] } } }))
    }
    await desktop({ blockAt, reached: false })
    const runner = join(root, 'crash-runner.mjs'), optionsFile = join(root, 'options.json')
    // The crash runs main's own Omarchy setup, whose words are messages, so the runner is built as main is.
    await bundleDesktopMain('tests/fixtures/omarchySetupCrash.ts', runner, { format: 'es' })
    await writeFile(optionsFile, JSON.stringify({ home, data, resources: resolve('apps/omarchy'),
      environment: { PATH: `${bin}:/usr/bin:/bin`, OMARCHY_PATH: join(root, 'omarchy'), XDG_RUNTIME_DIR: join(root, 'runtime'), SOTTO_SETUP_FIXTURE_STATE: stateFile } }))
    const child = spawn(process.execPath, [runner, optionsFile, piece, operation], { detached: true, stdio: 'ignore' })
    const exited = new Promise<void>((resolveExit, reject) => { child.once('exit', () => resolveExit()); child.once('error', reject) })
    try {
      await expect.poll(async () => JSON.parse(await readFile(stateFile, 'utf8')).reached).toBe(true)
      if (operation === 'setup') expect(await readFile(join(home, installed), 'utf8')).not.toBe('')
      process.kill(-child.pid!, 'SIGKILL') // Only this explicitly created fixture group, including its blocked command.
      await exited
      await desktop({ blockAt: '', reached: false })
      const laterBarEdit = blockAt.startsWith('after omarchy bar put')
      if (laterBarEdit) {
        const configPath = join(home, '.config/omarchy/shell.json'), config = JSON.parse(await readFile(configPath, 'utf8'))
        config.bar.layout.center[0].command = '/later/sotto'
        await writeFile(configPath, JSON.stringify(config))
      }
      try { settings = JSON.parse(await readFile(join(data, 'settings.json'), 'utf8')) } catch { /* No appearance update. */ }
      const reopened = make(), state = await reopened.get()
      expect(state.pieces[piece]).toMatchObject({ status: 'failed', owned: true, retry: operation })
      if (serviceRepair) {
        expect((await reopened.command({ type: 'setup', pieces: ['owl'], keys: 'give' })).pieces.owl.status).toBe('done')
        const config = JSON.parse(await readFile(join(home, '.config/omarchy/shell.json'), 'utf8'))
        expect(config.bar.layout.center).toContainEqual({ id: 'sotto.dictation', command: laterBarEdit ? '/later/sotto' : '/my/sotto', pillEdge: 'bottom' })
      }
      expect((await reopened.command({ type: 'remove', pieces: [piece] })).pieces[piece].status).toBe('missing')
      expect(await readFile(join(home, installed), 'utf8').catch(() => null)).toBeNull()
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid!, 'SIGKILL') } catch { /* Already stopped. */ }
        await exited
      }
    }
  })
})
