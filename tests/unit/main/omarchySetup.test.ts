// @vitest-environment node
import { chmod, cp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inspectDictationBindings } from '../../../src/main/omarchy/setup'
import { omarchySetupFixture, sottoBinds, voxtypeBinds } from '../../fixtures/omarchySetup'
import { OMARCHY_THEME_ID } from '../../../src/shared/themes/omarchy'
import { OMARCHY_PIECES } from '../../../src/shared/omarchySetup'

describe('Omarchy setup in main', () => {
  let f: Awaited<ReturnType<typeof omarchySetupFixture>>
  beforeEach(async () => { f = await omarchySetupFixture() })
  afterEach(async () => { await f?.dispose() })
  const setup = () => f.make().command({ type: 'setup', pieces: [...OMARCHY_PIECES], keys: 'give' })

  it('detects every chord and F9 release separately, ignoring other modifiers', () => {
    expect(inspectDictationBindings(sottoBinds).manual).toBe(true)
    expect(inspectDictationBindings(sottoBinds.filter(bind => !bind.release)).manual).toBe(false)
    expect(inspectDictationBindings([...voxtypeBinds, { key: 'F9', modmask: 64, dispatcher: 'exec', arg: 'something' }]).conflicts).toEqual([])
    expect(inspectDictationBindings([{ key: 'X', modmask: 68, dispatcher: 'exec', arg: 'other', description: 'Open notes' }]).conflicts).toEqual(['Super+Ctrl+X runs “Open notes”.'])
  })
  it('reads native Hyprland Lua callback bindings by their distinct descriptions', () => {
    const stock = [
      { key: 'F9', modmask: 0, release: false, dispatcher: '__lua', arg: '7', description: 'Start dictation (push-to-talk)' },
      { key: 'F9', modmask: 0, release: true, dispatcher: '__lua', arg: '9', description: 'Stop dictation (push-to-talk)' },
      { key: 'X', modmask: 68, release: false, dispatcher: '__lua', arg: '5', description: 'Toggle dictation' },
    ]
    expect(inspectDictationBindings(stock)).toMatchObject({ voxtype: true, conflicts: [], manual: false })
    expect(inspectDictationBindings(stock, true)).toMatchObject({ voxtype: false, conflicts: [], manual: true })
    const ours = stock.map(bind => ({ ...bind, description: bind.description.replace('dictation', 'Sotto dictation') }))
    expect(inspectDictationBindings(ours)).toMatchObject({ voxtype: false, conflicts: [], manual: true })
    expect(inspectDictationBindings([{ ...ours[0], description: 'Take a screenshot' }]).conflicts).toEqual(['F9 runs “Take a screenshot”.'])
  })
  it('refuses a conflict that appeared after the user saw an unoccupied key', async () => {
    const engine = f.make()
    expect((await engine.get()).keyConflicts).toEqual([])
    f.desktop.binds = [{ ...voxtypeBinds[0]!, arg: 'screenrecord', description: 'Toggle screen recording' }]
    expect((await engine.command({ type: 'setup', pieces: ['keys'], keys: 'unconfirmed' })).pieces.keys.status).toBe('conflict')
    expect(await readFile(f.snippet, 'utf8').catch(() => null)).toBeNull()
  })
  it('inspects a fresh home without writing any file', async () => {
    const state = await f.make().get()
    expect(Object.values(state.pieces).map(piece => piece.status)).toEqual(['missing', 'missing', 'missing'])
    expect(state.voxtype).toBe(true)
    expect(await readFile(f.bindings, 'utf8')).toBe('-- My keys\n')
    expect(await readdir(join(f.home, '.config/hypr'))).toEqual(['bindings.lua'])
  })
  it('sets up all three, backs up keys, selects both Appearance columns and skips a second run', async () => {
    const engine = f.make(), beforeAppearance = f.settings().appearance
    const result = await engine.command({ type: 'setup', pieces: [...OMARCHY_PIECES], keys: 'give' })
    expect(Object.values(result.pieces).map(piece => piece.status)).toEqual(['done', 'done', 'done'])
    expect(f.settings()).toMatchObject({ appearance: 'system', theme: 'system', lightTheme: OMARCHY_THEME_ID, darkTheme: OMARCHY_THEME_ID })
    const backup = (await readdir(join(f.home, '.config/hypr'))).find(name => name.startsWith('bindings.lua.bak.'))!
    expect(await readFile(join(f.home, '.config/hypr', backup), 'utf8')).toBe('-- My keys\n')
    expect((await readFile(f.bindings, 'utf8')).match(/require\("hypr.sotto-bindings"\)/g)).toHaveLength(1)
    const mutations = f.calls.filter(call => /reload|^bash|bar put/.test(call)).length
    await engine.command({ type: 'setup', pieces: [...OMARCHY_PIECES], keys: 'give' })
    expect(f.calls.filter(call => /reload|^bash|bar put/.test(call))).toHaveLength(mutations)
    await engine.command({ type: 'remove', pieces: [...OMARCHY_PIECES] })
    expect(f.settings().appearance).toBe(beforeAppearance)
    expect(await readFile(f.bindings, 'utf8')).toBe('-- My keys\n')
    expect(await readdir(join(f.home, '.config/hypr'))).toContain(backup)
  })
  it('leaves a shell-down owl wholly absent while setting up keys and theme', async () => {
    f.desktop.shell = false
    const result = await setup()
    expect(result.pieces.owl.status).toBe('failed')
    expect(result.pieces.owl.message).toContain('Nothing was copied or removed')
    expect(await readFile(join(f.plugin, 'manifest.json'), 'utf8').catch(() => null)).toBeNull()
    expect(f.desktop.onBar).toBe(false)
    expect(result.pieces.keys.status).toBe('done')
    expect(result.pieces.theme.status).toBe('done')
  })
  it.each(['give', 'keep', 'unconfirmed'] as const)('handles a non-Voxtype conflict with %s', async choice => {
    f.desktop.binds = [{ ...voxtypeBinds[0]!, arg: 'screenrecord', description: 'Toggle screen recording' }]
    const engine = f.make()
    expect((await engine.get()).keyConflicts).toEqual(['F9 runs “Toggle screen recording”.'])
    const result = await engine.command({ type: 'setup', pieces: ['keys'], keys: choice })
    expect(result.pieces.keys.status).toBe(choice === 'give' ? 'done' : choice === 'keep' ? 'skipped' : 'conflict')
    expect(await readFile(f.snippet, 'utf8').catch(() => null)).toBe(choice === 'give' ? await readFile(join(f.resources, 'bindings.lua'), 'utf8') : null)
  })
  it('rolls back a new Hyprland error, preserving and displaying its line without logging', async () => {
    f.desktop.newError = 'line 58: unexpected symbol near end\n'
    const result = await f.make().command({ type: 'setup', pieces: ['keys'], keys: 'give' })
    expect(result.pieces.keys.status).toBe('failed')
    expect(result.pieces.keys.message).toContain('line 58: unexpected symbol near end')
    expect(result.pieces.keys.message).toContain('Sotto restored your files')
    expect(await readFile(f.bindings, 'utf8')).toBe('-- My keys\n')
    expect(await readFile(f.snippet, 'utf8').catch(() => null)).toBeNull()
  })
  it('compares against existing Hyprland errors instead of refusing an unchanged error', async () => {
    f.desktop.errors = 'An old unrelated error\n'
    expect((await setup()).pieces.keys.status).toBe('done')
  })
  it('does not write a key file when luac fails', async () => {
    f.desktop.lua = false
    expect((await setup()).pieces.keys.status).toBe('failed')
    expect(await readdir(join(f.home, '.config/hypr'))).toEqual(['bindings.lua'])
  })
  it('rolls back when the Lua parses but Hyprland never loads the snippet', async () => {
    f.desktop.appliesKeys = false
    const result = await f.make().command({ type: 'setup', pieces: ['keys'], keys: 'give' })
    expect(result.pieces.keys.status).toBe('failed')
    expect(result.pieces.keys.message).toContain('Hyprland did not load')
    expect(await readFile(f.bindings, 'utf8')).toBe('-- My keys\n')
    expect(await readFile(f.snippet, 'utf8').catch(() => null)).toBeNull()
  })
  it('counts all hand-installed pieces as done and never edits or removes them', async () => {
    f.desktop.binds = sottoBinds
    await cp(join(f.resources, 'shell-plugin/sotto.dictation'), f.plugin, { recursive: true })
    await f.run('omarchy', ['bar', 'put', 'sotto.dictation'])
    await f.write(f.template, 'Hand template')
    await f.write(f.rendered, 'Hand colours')
    const engine = f.make(), before = await readFile(f.config, 'utf8')
    expect(Object.values((await engine.get()).pieces).map(piece => piece.status)).toEqual(['manual', 'manual', 'manual'])
    await engine.command({ type: 'setup', pieces: [...OMARCHY_PIECES], keys: 'give' })
    await engine.command({ type: 'remove', pieces: [...OMARCHY_PIECES] })
    expect(await readFile(f.config, 'utf8')).toBe(before)
    expect(await readFile(f.template, 'utf8')).toBe('Hand template')
    expect(await readFile(f.rendered, 'utf8')).toBe('Hand colours')
  })
  it('removes only its own key line and keeps later user edits', async () => {
    const engine = f.make()
    await engine.command({ type: 'setup', pieces: ['keys'], keys: 'give' })
    await writeFile(f.bindings, `${await readFile(f.bindings, 'utf8')}-- Added later\n`)
    const result = await engine.command({ type: 'remove', pieces: ['keys'] })
    expect(result.pieces.keys.message).toContain('Voxtype’s again')
    expect(await readFile(f.bindings, 'utf8')).toBe('-- My keys\n-- Added later\n')
  })
  it('preserves an inactive hand-installed snippet without counting its keys as ready', async () => {
    await cp(join(f.resources, 'bindings.lua'), f.snippet)
    const engine = f.make()
    expect((await engine.get()).pieces.keys.status).toBe('conflict')
    await engine.command({ type: 'setup', pieces: ['keys'], keys: 'give' })
    expect(await readFile(f.bindings, 'utf8')).toBe('-- My keys\n')
    expect(f.calls).not.toContain('hyprctl reload')
  })
  it('repairs an owned theme whose rendered palette went missing', async () => {
    const engine = f.make()
    await engine.command({ type: 'setup', pieces: ['theme'], keys: 'give' })
    await rm(f.rendered)
    expect((await engine.get()).pieces.theme).toMatchObject({ status: 'missing', owned: true })
    expect((await engine.command({ type: 'setup', pieces: ['theme'], keys: 'give' })).pieces.theme.status).toBe('done')
    expect(await readFile(f.rendered, 'utf8')).toContain('accent')
  })
  it('keeps the owl update question when its bar entry needs repair', async () => {
    const engine = f.make()
    await engine.command({ type: 'setup', pieces: ['owl'], keys: 'give' })
    await f.run('omarchy', ['plugin', 'disable', 'sotto.dictation'])
    await f.write(join(f.resources, 'shell-plugin/sotto.dictation/new.qml'), 'new plugin')
    expect((await engine.get()).pieces.owl).toMatchObject({ status: 'stale', owned: true })
    await engine.command({ type: 'setup', pieces: ['owl'], keys: 'give' })
    expect(await readFile(join(f.plugin, 'new.qml'), 'utf8').catch(() => null)).toBeNull()
    expect((await engine.command({ type: 'update-owl' })).pieces.owl.status).toBe('done')
    expect(f.desktop.restartCount).toBe(1)
  })
  it('repairs an owl enabled only as a service without counting it as on the bar', async () => {
    const engine = f.make()
    await engine.command({ type: 'setup', pieces: ['owl'], keys: 'give' })
    const config = JSON.parse(await readFile(f.config, 'utf8'))
    config.plugins = [{ id: 'sotto.dictation', command: '/my/sotto' }]
    config.bar.layout.center = [{ id: 'omarchy.indicators' }]
    await writeFile(f.config, JSON.stringify(config))
    expect((await engine.get()).pieces.owl).toMatchObject({ status: 'missing', owned: true })
    expect((await engine.command({ type: 'setup', pieces: ['owl'], keys: 'unconfirmed' })).pieces.owl.status).toBe('done')
    expect(JSON.parse(await readFile(f.config, 'utf8')).bar.layout.center).toContainEqual({ id: 'sotto.dictation', command: '/my/sotto' })
  })
  it('asks about new conflicts on owned keys after an update', async () => {
    const engine = f.make()
    await engine.command({ type: 'setup', pieces: ['keys'], keys: 'give' })
    await f.write(join(f.resources, 'bindings.lua'), `${await readFile(join(f.resources, 'bindings.lua'), 'utf8')}\n-- update\n`)
    f.desktop.binds = [{ ...voxtypeBinds[0]!, arg: 'screenrecord', description: 'Record the screen' }]
    expect((await engine.refreshAtStart()).pieces.keys).toMatchObject({ status: 'stale', owned: true })
    expect((await engine.command({ type: 'setup', pieces: ['keys'], keys: 'keep' })).pieces.keys).toMatchObject({ status: 'skipped', owned: true })
    expect((await engine.command({ type: 'setup', pieces: ['keys'], keys: 'give' })).pieces.keys.status).toBe('done')
  })
  it('refuses edited copies, extra plugin files and linked paths', async () => {
    await setup()
    await writeFile(f.snippet, '-- edited by me\n')
    await f.write(join(f.plugin, 'mine.qml'), 'my plugin changes')
    await writeFile(f.template, 'my template')
    const engine = f.make()
    expect(Object.values((await engine.get()).pieces).map(piece => piece.status)).toEqual(['conflict', 'conflict', 'conflict'])
    await engine.command({ type: 'remove', pieces: [...OMARCHY_PIECES] })
    expect(await readFile(f.snippet, 'utf8')).toBe('-- edited by me\n')
    expect(await readFile(f.template, 'utf8')).toBe('my template')
    await rm(f.snippet)
    if (process.platform !== 'win32') {
      await symlink(f.bindings, f.snippet)
      expect((await f.make().get()).pieces.keys.message).toContain('linked or special')
    }
  })
  it('refreshes owned keys and theme at start but waits before restarting the owl', async () => {
    await setup()
    await writeFile(join(f.resources, 'bindings.lua'), `${await readFile(join(f.resources, 'bindings.lua'), 'utf8')}\n-- new keys\n`)
    await writeFile(join(f.resources, 'sotto.json.tpl'), 'new template')
    await f.write(join(f.resources, 'shell-plugin/sotto.dictation/new.qml'), 'new plugin')
    const engine = f.make()
    expect(Object.values((await engine.get()).pieces).map(piece => piece.status)).toEqual(['stale', 'stale', 'stale'])
    const result = await engine.refreshAtStart()
    expect(result.pieces.keys.status).toBe('done')
    expect(result.pieces.theme.message).toContain('Updated for Sotto')
    expect(result.pieces.owl.status).toBe('stale')
    expect(f.desktop.restartCount).toBe(0)
    await engine.command({ type: 'setup', pieces: ['owl'], keys: 'give' })
    expect(f.desktop.restartCount).toBe(0)
    const updated = await engine.command({ type: 'update-owl' })
    expect(updated.pieces.owl.status).toBe('done')
    expect(f.desktop.restartCount).toBe(1)
  })
  it('keeps the initial key backup in its record after an update', async () => {
    const engine = f.make()
    await engine.command({ type: 'setup', pieces: ['keys'], keys: 'give' })
    const first = JSON.parse(await readFile(join(f.data, 'omarchy-setup.json'), 'utf8')).pieces.keys
    await f.write(join(f.resources, 'bindings.lua'), `${await readFile(join(f.resources, 'bindings.lua'), 'utf8')}\n-- update\n`)
    await engine.refreshAtStart()
    const current = JSON.parse(await readFile(join(f.data, 'omarchy-setup.json'), 'utf8')).pieces.keys
    expect(current.backup).toBe(first.backup)
    expect(await readFile(current.backup, 'utf8')).toBe('-- My keys\n')
  })
  it('restores an originally absent key file after removal and keeps later edits', async () => {
    await rm(f.bindings)
    const engine = f.make()
    await engine.command({ type: 'setup', pieces: ['keys'], keys: 'give' })
    await engine.command({ type: 'remove', pieces: ['keys'] })
    expect(await readFile(f.bindings, 'utf8').catch(() => null)).toBeNull()
    await engine.command({ type: 'setup', pieces: ['keys'], keys: 'give' })
    await writeFile(f.bindings, `${await readFile(f.bindings, 'utf8')}-- Added later\n`)
    await engine.command({ type: 'remove', pieces: ['keys'] })
    expect(await readFile(f.bindings, 'utf8')).toBe('-- Added later\n')
  })
  it('does not claim a key backup after removing only hand setup', async () => {
    f.desktop.binds = sottoBinds
    const removed = await f.make().command({ type: 'remove', pieces: [...OMARCHY_PIECES] })
    expect(removed.notice).toBe('')
  })
  it.runIf(process.platform !== 'win32')('preserves private key-file permissions and protects its backup', async () => {
    await chmod(f.bindings, 0o600)
    await f.make().command({ type: 'setup', pieces: ['keys'], keys: 'give' })
    expect((await stat(f.bindings)).mode & 0o777).toBe(0o600)
    const receipt = JSON.parse(await readFile(join(f.data, 'omarchy-setup.json'), 'utf8')).pieces.keys
    expect((await stat(receipt.backup)).mode & 0o777).toBe(0o600)
  })
  it('refuses another process’s leftover owl folder without stranding or replacing it', async () => {
    const engine = f.make()
    await engine.command({ type: 'setup', pieces: ['owl'], keys: 'give' })
    const leftover = join(f.home, '.config/omarchy/plugins/.sotto.dictation.previous-1234')
    const { rename } = await import('node:fs/promises')
    await rename(f.plugin, leftover)
    const result = await f.make().command({ type: 'setup', pieces: ['owl'], keys: 'give' })
    expect(result.pieces.owl.status).toBe('failed')
    expect(await readFile(join(f.plugin, 'manifest.json'), 'utf8').catch(() => null)).toBeNull()
    expect(await readFile(join(leftover, 'manifest.json'), 'utf8')).toContain('sotto.dictation')
  })
  it('restores the previous owl and bar if placement fails', async () => {
    const before = await readFile(f.config, 'utf8')
    f.desktop.fail = 'omarchy bar put'
    expect((await setup()).pieces.owl.status).toBe('failed')
    expect(await readFile(f.config, 'utf8')).toBe(before)
    expect(await readFile(join(f.plugin, 'manifest.json'), 'utf8').catch(() => null)).toBeNull()
  })
  it('keeps unrelated shell settings and bar entries saved during a failed owl command', async () => {
    const engine = f.make(async (command, args) => {
      if (command === 'omarchy' && args[0] === 'bar') {
        const latest = JSON.parse(await readFile(f.config, 'utf8'))
        latest.idle = { lock: 600 }
        latest.bar.layout.center.push({ id: 'my.clock' }, { id: 'sotto.dictation' })
        await writeFile(f.config, JSON.stringify(latest))
        return { ok: false, stdout: '', stderr: '' }
      }
      return f.run(command, args)
    })
    expect((await engine.command({ type: 'setup', pieces: ['owl'], keys: 'unconfirmed' })).pieces.owl.status).toBe('failed')
    const saved = JSON.parse(await readFile(f.config, 'utf8'))
    expect(saved.idle).toEqual({ lock: 600 })
    expect(saved.bar.layout.center).toEqual([{ id: 'omarchy.indicators' }, { id: 'my.clock' }])
    expect(await readFile(join(f.plugin, 'manifest.json'), 'utf8').catch(() => null)).toBeNull()
  })
  it('keeps later Appearance choices when the theme is removed', async () => {
    await setup()
    f.setSettings({ ...f.settings(), appearance: 'light', lightTheme: 'sotto' })
    await f.make().command({ type: 'remove', pieces: ['theme'] })
    expect(f.settings().appearance).toBe('light')
    expect(f.settings().lightTheme).toBe('sotto')
  })
  it('leaves a hand-rendered palette alone even without a template', async () => {
    await f.write(f.rendered, 'Hand-rendered colours')
    const engine = f.make()
    expect((await engine.get()).pieces.theme.status).toBe('manual')
    await engine.command({ type: 'setup', pieces: ['theme'], keys: 'unconfirmed' })
    await engine.command({ type: 'remove', pieces: ['theme'] })
    expect(await readFile(f.rendered, 'utf8')).toBe('Hand-rendered colours')
    expect(await readFile(f.template, 'utf8').catch(() => null)).toBeNull()
  })
})
