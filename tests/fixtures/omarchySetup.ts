import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings, type SettingsPatch } from '../../src/shared/settings'
import { OmarchySetup, type SetupRun } from '../../src/main/omarchy/setup'
import type { OmarchySetupState } from '../../src/shared/omarchySetup'
import omarchyThemes from './omarchy-themes.json'

export const voxtypeBinds = [
  { key: 'F9', modmask: 0, dispatcher: 'exec', arg: 'voxtype record start', release: false },
  { key: 'F9', modmask: 0, dispatcher: 'exec', arg: 'voxtype record stop', release: true },
  { key: 'X', modmask: 68, dispatcher: 'exec', arg: 'voxtype record toggle', release: false },
]
export const sottoBinds = voxtypeBinds.map((bind, at) => ({ ...bind, arg: `sh -c 'sotto dictation ${['start', 'stop', 'toggle'][at]} --at 1'` }))

/** Real files and saved ownership; scripted compositor/shell replies, never the live desktop. */
export async function omarchySetupFixture() {
  const root = await mkdtemp(join(tmpdir(), 'sotto-omarchy-test-'))
  const home = join(root, 'home'), data = join(root, 'data'), resources = join(root, 'resources')
  const bindings = join(home, '.config/hypr/bindings.lua'), snippet = join(home, '.config/hypr/sotto-bindings.lua')
  const plugin = join(home, '.config/omarchy/plugins/sotto.dictation'), config = join(home, '.config/omarchy/shell.json')
  const template = join(home, '.config/omarchy/themed/sotto.json.tpl'), rendered = join(home, '.local/state/omarchy/current/theme/sotto.json')
  const write = async (path: string, value: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }
  await mkdir(resources)
  for (const piece of ['bindings.lua', 'sotto.json.tpl', 'install-theme.sh', 'shell-plugin']) {
    await cp(resolve('apps/omarchy', piece), join(resources, piece), { recursive: true })
  }
  await write(bindings, '-- My keys\n')
  await write(config, JSON.stringify({ version: 1, bar: { layout: { center: [{ id: 'omarchy.indicators' }] } } }))
  const desktop: { binds: Array<{ key: string; modmask: number; dispatcher: string; arg: string; release: boolean; description?: string }>; shell: boolean; lua: boolean; errors: string; newError: string; fail: string; restartCount: number; onBar: boolean; theme: boolean; appliesKeys: boolean } = { binds: voxtypeBinds, shell: true, lua: true, errors: '', newError: '', appliesKeys: true,
    fail: '', restartCount: 0, onBar: false, theme: true }
  const calls: string[] = [], changes: OmarchySetupState[] = []
  let settings = structuredClone(DEFAULT_SETTINGS)
  const run: SetupRun = async (command, args) => {
    const key = [command, ...args].join(' ')
    calls.push(key)
    const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' })
    const no = () => ({ ok: false, stdout: '', stderr: 'private command error' })
    if (desktop.fail && key.startsWith(desktop.fail)) return no()
    if (key === 'hyprctl binds -j') return ok(JSON.stringify(desktop.binds))
    if (key === 'hyprctl configerrors') {
      const file = await readFile(bindings, 'utf8').catch(() => '')
      return ok(desktop.errors + (file.includes('-- Sotto Omarchy setup') ? desktop.newError : ''))
    }
    if (key === 'hyprctl reload') {
      const file = await readFile(bindings, 'utf8').catch(() => '')
      if (!desktop.newError && desktop.appliesKeys) desktop.binds = file.includes('-- Sotto Omarchy setup') ? sottoBinds : voxtypeBinds
      return ok()
    }
    if (command === 'luac') return desktop.lua ? ok() : no()
    if (key === 'omarchy-shell shell ping') return desktop.shell ? ok() : no()
    if (key === 'omarchy-shell shell listPlugins') return ok('[{"id":"sotto.dictation"}]')
    if (key.startsWith('omarchy bar put') || key.startsWith('omarchy plugin disable')) {
      const settings = JSON.parse(await readFile(config, 'utf8'))
      settings.bar.layout.center = key.startsWith('omarchy bar put')
        ? [{ id: 'omarchy.indicators' }, { id: 'sotto.dictation' }] : [{ id: 'omarchy.indicators' }]
      desktop.onBar = key.startsWith('omarchy bar put')
      await writeFile(config, JSON.stringify(settings))
      return ok()
    }
    if (key === 'omarchy restart shell') { desktop.restartCount++; return ok() }
    if (command === 'bash') {
      if (!desktop.theme) return no()
      if (args.includes('--uninstall')) { await rm(template, { force: true }); await rm(rendered, { force: true }); return ok() }
      await write(template, await readFile(join(resources, 'sotto.json.tpl'), 'utf8'))
      await write(rendered, JSON.stringify(omarchyThemes.themes.catppuccin.rendered))
      return ok()
    }
    return ok()
  }
  const make = (runOverride: SetupRun = run) => new OmarchySetup({ home, data, resources, version: '9.0.0', run: runOverride,
    settings: { get: async () => settings, update: async (patch: SettingsPatch) => { settings = { ...settings, ...patch, worktreeCleanup: { ...settings.worktreeCleanup, ...patch.worktreeCleanup } }; return settings } },
    onChanged: state => changes.push(state) })
  return { root, home, data, resources, bindings, snippet, plugin, config, template, rendered, desktop, calls, changes, run, make,
    settings: () => settings, setSettings: (next: AppSettings) => { settings = next }, write,
    dispose: () => rm(root, { recursive: true, force: true }) }
}
